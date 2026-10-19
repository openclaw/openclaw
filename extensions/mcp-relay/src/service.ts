import { randomBytes, randomUUID } from "node:crypto";
import type { GatewayControlUiIngressFactoryV2 } from "openclaw/plugin-sdk/gateway-ingress";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { WebSocket, type RawData } from "openclaw/plugin-sdk/websocket-runtime";
import { ownsGrant, type RelayCaller } from "./caller.js";
import type { GatewayRequest } from "./gateway-request.js";
import { GrantBindings, isRetiredBindingError } from "./grant-bindings.js";
import {
  capResult,
  codeHash,
  createPairingCode,
  identityFromPrivateKey,
  MAX_FRAME_BYTES,
  RelayError,
  safeError,
  relayResponseError,
  readGrantCreation,
} from "./protocol.js";
import type { RelayState, RelayGrantAuthority } from "./state.js";
import { readUiFrameAncestors, UiTunnelError } from "./ui-tunnel-protocol.js";
import { UiTunnel } from "./ui-tunnel.js";

export type RelaySocket = {
  readonly bufferedAmount: number;
  on(event: "message", listener: (data: RawData, binary: boolean) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
};
type Identity = ReturnType<typeof identityFromPrivateKey>;
type ConfigSnapshot = ReturnType<PluginRuntime["config"]["current"]>;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cancel: () => void;
};
type ServiceOptions = {
  scheduler: PluginServiceSchedulerV1;
  state: RelayState;
  identity: Identity;
  relayUrl: string;
  gateway: { name: string; version: string };
  controlUiIngress?: GatewayControlUiIngressFactoryV2;
  config: () => ConfigSnapshot;
  operations: (
    op: string,
    params: unknown,
    assertAuthority: () => void,
    request: GatewayRequest,
  ) => Promise<unknown>;
  socketFactory?: (url: string) => RelaySocket;
};

export class RelayService {
  readonly #options: ServiceOptions;
  readonly #ingress: GatewayControlUiIngressFactoryV2;
  readonly #pending = new Map<string, Pending>();
  #socket?: RelaySocket;
  #connection?: PluginServiceSchedulerV1;
  #ready = false;
  #attempt = 0;
  #ui?: UiTunnel;
  #bindings?: GrantBindings;

  constructor(options: ServiceOptions) {
    this.#options = options;
    if (!options.controlUiIngress) {
      throw new RelayError(
        "unavailable",
        "Update OpenClaw to enable principal-bound MCP and Control UI access.",
      );
    }
    this.#ingress = options.controlUiIngress;
  }

  start(): void {
    this.#options.scheduler.schedule({ id: "connect", delayMs: 0, run: () => this.#connect() });
  }

  async stop(): Promise<void> {
    this.#ready = false;
    this.#rejectPending();
    const closing = this.#closeUi();
    this.#options.scheduler.beginClose();
    this.#socket?.terminate();
    this.#socket = undefined;
    await closing;
    await this.#options.scheduler.stop();
  }

  async status() {
    const grants = await this.#options.state.grants();
    return {
      connected: this.#ready,
      gatewayId: this.#options.identity.gatewayId,
      relayUrl: this.#options.relayUrl,
      grantsCount: grants.length,
      ui: this.#uiStatus(),
    };
  }

  #uiStatus(): { available: boolean; basePath?: string; reason?: string } {
    const config = this.#options.config();
    if (!this.#ui) {
      return {
        available: false,
        reason: "Update the MCP relay to support the Control UI tunnel, then reconnect.",
      };
    }
    const path = config.gateway?.controlUi?.basePath?.trim().replace(/^\/+|\/+$/gu, "");
    return { available: true, basePath: path ? `/${path}` : "/" };
  }

  async #closeUi(): Promise<void> {
    const bindings = this.#bindings;
    const ui = this.#ui;
    this.#bindings = undefined;
    this.#ui = undefined;
    await Promise.allSettled([bindings?.close(), ui?.close()]);
  }

  async grants(caller?: RelayCaller) {
    const grants = await this.#options.state.grants();
    return {
      grants:
        caller && !caller.canAdmin ? grants.filter((grant) => ownsGrant(caller, grant)) : grants,
      ...(caller ? { caller, relayUrl: this.#options.relayUrl } : {}),
    };
  }

  async pair(assertCommandCurrent?: () => void, authority?: RelayGrantAuthority) {
    this.#requireReady();
    const selected = authority ?? {
      principal: { kind: "owner" as const },
      ceiling: ["operator.read", "operator.write"],
    };
    await this.#validateAuthority(
      selected,
      assertCommandCurrent ?? (() => this.#options.scheduler.signal.throwIfAborted()),
    );
    const code = createPairingCode();
    const expiresAt = this.#options.scheduler.now() + 10 * 60_000;
    const hash = codeHash(code);
    await this.#options.state.issue(
      hash,
      expiresAt,
      this.#options.scheduler.now(),
      assertCommandCurrent,
      selected,
    );
    assertCommandCurrent?.();
    this.#requireReady();
    await this.#request("pair.offer", {
      codeHash: hash,
      expiresAt,
      principal: selected.principal.kind,
      ...(selected.principalLabel ? { principalLabel: selected.principalLabel } : {}),
      ceiling: selected.ceiling,
    });
    assertCommandCurrent?.();
    this.#requireReady();
    return { code, expiresAt, mcpUrl: new URL("/mcp", this.#options.relayUrl).href };
  }

  async revoke(grantId: string, assertCommandCurrent?: () => void) {
    assertCommandCurrent?.();
    if (!(await this.#options.state.revoke(grantId, assertCommandCurrent))) {
      throw new RelayError(
        "not_found",
        "Grant not found. Run openclaw mcp-relay grants and use a listed grant ID.",
      );
    }
    this.#ui?.revoke(grantId);
    await this.#bindings?.revoke(grantId);
    if (!this.#ready) {
      return { revoked: true, relayNotified: false };
    }
    try {
      await this.#request("grant.revoke", { grantId });
      return { revoked: true, relayNotified: true };
    } catch {
      // A missing local grant remains refused even if the relay is offline.
      return { revoked: true, relayNotified: false };
    }
  }

  async #validateAuthority(
    authority: RelayGrantAuthority,
    assertCurrent: () => void,
  ): Promise<void> {
    assertCurrent();
    const config = this.#options.config();
    if (
      authority.principal.kind === "owner" &&
      (config.gateway?.roles || config.gateway?.auth?.mode === "trusted-proxy")
    ) {
      throw new RelayError(
        "unavailable",
        "This Gateway requires a person-bound grant. Sign in and pair again from the Connected apps tab.",
      );
    }
    const binding = await this.#ingress.bindPrincipal({
      audienceId: `consent:${randomUUID()}`,
      principal: authority.principal,
      operatorScopeCeiling: authority.ceiling,
      signal: this.#options.scheduler.signal,
      assertCurrent,
    });
    await binding.close();
    assertCurrent();
  }

  async describeConsent(requestId: string, assertCurrent: () => void) {
    assertCurrent();
    const result = await this.#request("authorize.describe", { requestId });
    assertCurrent();
    if (
      !isRecord(result) ||
      (result.kind !== "oauth" && result.kind !== "link") ||
      typeof result.clientName !== "string" ||
      !result.clientName ||
      result.clientName.length > 2000 ||
      typeof result.redirectHost !== "string" ||
      !result.redirectHost ||
      result.redirectHost.length > 2000 ||
      typeof result.expiresAt !== "number" ||
      !Number.isSafeInteger(result.expiresAt) ||
      result.expiresAt <= this.#options.scheduler.now()
    ) {
      throw new RelayError(
        "not_found",
        "This connection request is invalid or expired. Start connecting again.",
      );
    }
    return {
      kind: result.kind,
      clientName: result.clientName,
      redirectHost: result.redirectHost,
      expiresAt: result.expiresAt,
      relayUrl: this.#options.relayUrl,
    };
  }

  #continueUrl(requestId: string): string {
    const url = new URL("/oauth/continue", this.#options.relayUrl);
    url.searchParams.set("request", requestId);
    return url.href;
  }

  async approveConsent(
    requestId: string,
    authority: RelayGrantAuthority,
    assertCurrent: () => void,
  ) {
    const details = await this.describeConsent(requestId, assertCurrent);
    await this.#validateAuthority(authority, assertCurrent);
    const grantId = `gr_${randomBytes(32).toString("base64url")}`;
    const assertApprovalCurrent = () => {
      assertCurrent();
      this.#requireReady();
      if (this.#options.scheduler.now() >= details.expiresAt) {
        throw new RelayError(
          "not_found",
          "This connection request expired. Start connecting again.",
        );
      }
    };
    assertApprovalCurrent();
    await this.#options.state.approveGrant(
      {
        grantId,
        clientId: requestId,
        clientName: details.clientName,
        createdAt: this.#options.scheduler.now(),
        ...authority,
      },
      assertApprovalCurrent,
    );
    try {
      assertApprovalCurrent();
      await this.#request("authorize.approve", {
        requestId,
        grantId,
        principal: authority.principal.kind,
        principalLabel:
          authority.principalLabel ??
          (authority.principal.kind === "owner" ? "Gateway owner" : "Gateway user"),
        ceiling: authority.ceiling,
      });
      assertApprovalCurrent();
      this.#options.state.assertGrantCurrent(grantId);
    } catch (error) {
      // An uncertain approval must never leave a usable local grant behind.
      await this.revoke(grantId);
      throw error;
    }
    return { continueUrl: this.#continueUrl(requestId) };
  }

  async denyConsent(requestId: string, assertCurrent: () => void) {
    await this.describeConsent(requestId, assertCurrent);
    assertCurrent();
    await this.#request("authorize.deny", { requestId });
    assertCurrent();
    return { continueUrl: this.#continueUrl(requestId) };
  }

  #requireReady(): void {
    if (!this.#ready || !this.#socket) {
      throw new RelayError(
        "unavailable",
        "The relay is disconnected. Check openclaw mcp-relay status, then try again.",
      );
    }
  }

  #connect(): void {
    const { relayUrl, identity, scheduler, socketFactory } = this.#options;
    const url = new URL("/v1/gateway/connect", relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("key", identity.publicKey);
    const connection = scheduler.scope();
    this.#connection = connection;
    let socket: RelaySocket;
    try {
      socket = (
        socketFactory ??
        ((address) =>
          new WebSocket(address, {
            maxPayload: MAX_FRAME_BYTES,
            followRedirects: false,
          }))
      )(url.href);
    } catch {
      void connection.stop();
      this.#retry(0);
      return;
    }
    this.#socket = socket;
    const bindings = new GrantBindings(this.#ingress, this.#options.state, connection.signal);
    this.#bindings = bindings;
    let helloSent = false;
    const current = () =>
      !scheduler.signal.aborted && !connection.signal.aborted && this.#socket === socket;
    const assertConnectionCurrent = () => {
      if (!current()) {
        throw new RelayError(
          "unavailable",
          "The relay disconnected. Check openclaw mcp-relay status and try again.",
        );
      }
    };
    const sendControlFrame = (frame: unknown) => {
      try {
        this.#send(socket, frame);
      } catch {
        socket.terminate();
      }
    };
    const armPongDeadline = () =>
      connection.schedule({
        id: "pong-deadline",
        delayMs: 60_000,
        run: () => {
          if (current()) {
            socket.close(1001, "Relay keepalive timed out");
            socket.terminate();
          }
        },
      });
    connection.schedule({
      id: "handshake",
      delayMs: 10_000,
      run: () => {
        if (current() && !this.#ready) {
          socket.close(4400, "Handshake timed out");
          socket.terminate();
        }
      },
    });
    socket.on("error", () => {
      if (current()) {
        socket.terminate();
      }
    });
    socket.on("close", (code) => {
      if (this.#socket !== socket) {
        return;
      }
      this.#ready = false;
      this.#socket = undefined;
      this.#rejectPending();
      void this.#closeUi();
      void connection.stop();
      this.#connection = undefined;
      if (!scheduler.signal.aborted) {
        this.#retry(code);
      }
    });
    socket.on("message", (data: RawData, binary: boolean) => {
      if (!current()) {
        return;
      }
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (binary) {
        socket.close(4400, "Text frames required");
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(bytes.toString("utf8"));
      } catch {
        socket.close(4400, "Invalid JSON");
        return;
      }
      if (!isRecord(frame)) {
        socket.close(4400, "Invalid frame");
        return;
      }
      if (!this.#ready) {
        if (
          frame.type === "challenge" &&
          !helloSent &&
          frame.protocol === 1 &&
          frame.relay === new URL(relayUrl).host &&
          typeof frame.nonce === "string" &&
          /^[A-Za-z0-9_-]{43}$/.test(frame.nonce) &&
          Buffer.from(frame.nonce, "base64url").length === 32 &&
          Buffer.from(frame.nonce, "base64url").toString("base64url") === frame.nonce
        ) {
          helloSent = true;
          sendControlFrame({
            type: "hello",
            protocol: 1,
            signature: identity.signChallenge(frame.nonce, frame.relay),
            gateway: this.#options.gateway,
          });
        } else if (frame.type === "ready" && helloSent && frame.gatewayId === identity.gatewayId) {
          let frameAncestors: string[] | undefined;
          try {
            frameAncestors = readUiFrameAncestors(frame.ui);
          } catch {
            socket.close(4400, "Invalid UI capability");
            return;
          }
          if (frameAncestors) {
            this.#ui = new UiTunnel({
              open: async (grantId, presentation) =>
                (await bindings.get(grantId)).openControlUi(presentation),
              frameAncestors,
              retireBinding: (grantId) => void bindings.revoke(grantId),
              scheduler: connection,
              assertGrantCurrent: (grantId) => {
                assertConnectionCurrent();
                this.#options.state.assertGrantCurrent(grantId);
              },
              send: (outgoing) => {
                assertConnectionCurrent();
                this.#send(socket, outgoing);
              },
              closeRelay: () => socket.terminate(),
            });
          }
          this.#ready = true;
          this.#attempt = 0;
          armPongDeadline();
          connection.schedule({
            id: "ping",
            delayMs: 30_000,
            everyMs: 30_000,
            run: () => {
              if (current()) {
                sendControlFrame({ type: "ping" });
              }
            },
          });
        } else {
          socket.close(4400, "Invalid handshake");
        }
        return;
      }
      if (frame.type === "pong") {
        armPongDeadline();
        return;
      }
      if (typeof frame.type === "string" && frame.type.startsWith("ui.")) {
        const uiStatus = this.#uiStatus();
        if (this.#ui && uiStatus.available) {
          this.#ui.receive(frame);
        } else if (typeof frame.sid === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(frame.sid)) {
          sendControlFrame({
            type: "ui.error",
            sid: frame.sid,
            code: "unavailable",
            message: uiStatus.reason,
          });
        } else {
          socket.close(4400, "Invalid UI frame");
        }
        return;
      }
      if (frame.type === "res" && typeof frame.id === "string") {
        const pending = this.#pending.get(frame.id);
        if (!pending) {
          return;
        }
        this.#pending.delete(frame.id);
        pending.cancel();
        if (frame.ok === true && isRecord(frame.result)) {
          pending.resolve(frame.result);
        } else {
          pending.reject(relayResponseError(frame.error));
        }
        return;
      }
      if (
        frame.type !== "req" ||
        typeof frame.id !== "string" ||
        frame.id.length > 128 ||
        !frame.id
      ) {
        socket.close(4400, "Invalid request");
        return;
      }
      const id = frame.id;
      const grantId =
        frame.op !== "grant.create" &&
        frame.op !== "grant.revoked" &&
        typeof frame.grantId === "string"
          ? frame.grantId
          : undefined;
      void (async () => {
        let response:
          | { ok: true; result: unknown }
          | { ok: false; error: ReturnType<typeof safeError> };
        try {
          response = {
            ok: true,
            result: capResult(await this.#handle(frame, assertConnectionCurrent, bindings)),
          };
        } catch (error) {
          response = { ok: false, error: safeError(error) };
        }
        if (!current()) {
          return;
        }
        try {
          if (grantId !== undefined) {
            this.#options.state.assertGrantCurrent(grantId);
          }
        } catch (error) {
          response = { ok: false, error: safeError(error) };
        }
        this.#send(socket, { type: "res", id, ...response });
      })().catch(() => socket.terminate());
    });
  }

  #retry(closeCode: number): void {
    const base =
      closeCode === 4401 ? 60_000 : Math.min(60_000, 1000 * 2 ** Math.min(this.#attempt++, 6));
    const delayMs = Math.min(60_000, Math.round(base * (0.8 + Math.random() * 0.4)));
    this.#options.scheduler.schedule({ id: "connect", delayMs, run: () => this.#connect() });
  }

  #send(socket: RelaySocket, frame: unknown): void {
    const text = JSON.stringify(frame);
    // A saturated relay may also lose the terminal error and reconnect instead.
    if (socket.bufferedAmount + Buffer.byteLength(text) > 32 * 1024 * 1024) {
      throw new UiTunnelError("limit_exceeded", "The relay send queue exceeded 32 MiB.");
    }
    socket.send(text);
  }

  #request(op: string, params: Record<string, unknown>): Promise<unknown> {
    this.#requireReady();
    const socket = this.#socket;
    if (!socket || !this.#connection) {
      throw new RelayError("unavailable", "Reconnect the MCP relay and try again.");
    }
    const id = randomUUID();
    const connection = this.#connection;
    return new Promise((resolve, reject) => {
      const timer = connection.schedule({
        id: `timeout:${id}`,
        delayMs: 15_000,
        run: () => {
          this.#pending.delete(id);
          reject(
            new RelayError(
              "timeout",
              "The relay did not respond. Check openclaw mcp-relay status before trying again.",
            ),
          );
        },
      });
      this.#pending.set(id, { resolve, reject, cancel: timer.cancel });
      try {
        this.#send(socket, { type: "req", id, op, params });
      } catch (error) {
        timer.cancel();
        this.#pending.delete(id);
        throw error;
      }
    });
  }

  #rejectPending(): void {
    for (const pending of this.#pending.values()) {
      pending.cancel();
      pending.reject(
        new RelayError(
          "unavailable",
          "The relay disconnected. Check openclaw mcp-relay status and try again.",
        ),
      );
    }
    this.#pending.clear();
  }

  async #handle(
    frame: Record<string, unknown>,
    assertConnectionCurrent: () => void,
    bindings: GrantBindings,
  ): Promise<unknown> {
    const { op, params } = frame;
    const { state, scheduler } = this.#options;
    if (typeof op !== "string") {
      throw new RelayError("invalid_params", "Supply a valid operation name.");
    }
    if (op !== "grant.create" && op !== "grant.revoked") {
      const { grantId } = frame;
      assertConnectionCurrent();
      if (typeof grantId !== "string" || !(await state.authorize(grantId, scheduler.now()))) {
        throw new RelayError(
          "grant_revoked",
          "This connection was revoked. Run openclaw mcp-relay pair and connect again.",
        );
      }
      const assertAuthority = () => {
        assertConnectionCurrent();
        state.assertGrantCurrent(grantId);
      };
      const binding = await bindings.get(grantId);
      const result = await this.#options.operations(
        op,
        params,
        assertAuthority,
        async (...args) => {
          try {
            return await binding.request(...args);
          } catch (error) {
            if (isRetiredBindingError(error)) {
              this.#ui?.retire(grantId, error);
              await bindings.revoke(grantId);
            }
            throw error;
          }
        },
      );
      return op === "status" && isRecord(result) ? { ...result, ui: this.#uiStatus() } : result;
    }
    if (
      !isRecord(params) ||
      typeof params.grantId !== "string" ||
      !params.grantId ||
      params.grantId.length > 200
    ) {
      throw new RelayError("invalid_params", "Supply a valid grantId and retry the request.");
    }
    if (op === "grant.revoked") {
      if (
        (params.reason !== "client_revoked" && params.reason !== "refresh_reuse") ||
        Object.keys(params).some((key) => !["grantId", "reason"].includes(key))
      ) {
        throw new RelayError("invalid_params", "Supply a valid revocation reason.");
      }
      await state.revoke(params.grantId);
      this.#ui?.revoke(params.grantId);
      await bindings.revoke(params.grantId);
      return {};
    }
    if (
      !(await state.createGrant(
        {
          grantId: params.grantId,
          ...readGrantCreation(params),
        },
        scheduler.now(),
      ))
    ) {
      throw new RelayError(
        "not_found",
        "That pairing code is unknown, expired, or already used. Run openclaw mcp-relay pair again.",
      );
    }
    return {};
  }
}
