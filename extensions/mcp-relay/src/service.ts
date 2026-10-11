import { randomUUID } from "node:crypto";
import type { GatewayControlUiIngressFactoryV1 } from "openclaw/plugin-sdk/gateway-ingress";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { WebSocket, type RawData } from "openclaw/plugin-sdk/websocket-runtime";
import {
  capResult,
  codeHash,
  createPairingCode,
  identityFromPrivateKey,
  MAX_FRAME_BYTES,
  RelayError,
  safeError,
} from "./protocol.js";
import type { RelayState } from "./state.js";
import { UI_BUFFER_BYTES } from "./ui-tunnel-protocol.js";
import { UiTunnel } from "./ui-tunnel.js";

export type RelaySocket = {
  readonly bufferedAmount?: number;
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
  state: Pick<
    RelayState,
    | "issue"
    | "createGrant"
    | "authorize"
    | "revoke"
    | "recordRevocation"
    | "grants"
    | "assertGrantCurrent"
  >;
  identity: Identity;
  relayUrl: string;
  gateway: { name: string; version: string };
  controlUiIngress?: GatewayControlUiIngressFactoryV1;
  config: () => ConfigSnapshot;
  operations: (
    op: string,
    params: unknown,
    assertAuthority: () => Promise<void>,
  ) => Promise<unknown>;
  socketFactory?: (url: string) => RelaySocket;
  random?: () => number;
};

function readUiFrameAncestors(ui: unknown): string[] | undefined {
  if (ui === undefined) {
    return undefined;
  }
  if (
    !isRecord(ui) ||
    !Array.isArray(ui.frameAncestors) ||
    !ui.frameAncestors.every(
      (value): value is string => typeof value === "string" && value.length > 0,
    ) ||
    ui.frameAncestors.length > 16 ||
    ui.frameAncestors.join(" ").length > 4096
  ) {
    throw new RelayError("invalid_params", "Invalid UI capability");
  }
  return ui.frameAncestors;
}

export class RelayService {
  readonly #options: ServiceOptions;
  readonly #pending = new Map<string, Pending>();
  #socket?: RelaySocket;
  #connection?: PluginServiceSchedulerV1;
  #ready = false;
  #stopped = false;
  #attempt = 0;
  #sequence = 0;
  #ui?: UiTunnel;
  #unsupportedUi?: { config: ConfigSnapshot; reason: string };
  readonly #closingUi = new Set<Promise<void>>();

  constructor(options: ServiceOptions) {
    this.#options = options;
  }

  start(): void {
    this.#options.scheduler.schedule({ id: "connect", delayMs: 0, run: () => this.#connect() });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#ready = false;
    this.#rejectPending();
    this.#closeUi();
    this.#options.scheduler.beginClose();
    this.#socket?.terminate();
    this.#socket = undefined;
    await Promise.allSettled(this.#closingUi);
    await this.#options.scheduler.stop();
  }

  #assertCurrent(): void {
    if (this.#stopped || this.#options.scheduler.signal.aborted) {
      throw new RelayError(
        "unavailable",
        "MCP relay is stopped. Enable the plugin and start the Gateway.",
      );
    }
  }

  async status() {
    const grants = await this.#options.state.grants();
    this.#assertCurrent();
    return {
      connected: this.#ready,
      gatewayId: this.#options.identity.gatewayId,
      relayUrl: this.#options.relayUrl,
      grantsCount: grants.filter((grant) => grant.revokedAt === undefined).length,
      ui: this.#uiStatus(),
    };
  }

  #uiStatus(): { available: boolean; basePath?: string; reason?: string } {
    const config = this.#options.config();
    if (this.#unsupportedUi?.config !== config) {
      this.#unsupportedUi = undefined;
    }
    if (!this.#options.controlUiIngress) {
      return {
        available: false,
        reason: "Update OpenClaw on this Gateway to show the full Control UI in ChatGPT.",
      };
    }
    if (!this.#ui) {
      return {
        available: false,
        reason: "Update the MCP relay to support the Control UI tunnel, then reconnect.",
      };
    }
    if (this.#unsupportedUi) {
      return { available: false, reason: this.#unsupportedUi.reason };
    }
    const path = config.gateway?.controlUi?.basePath?.trim().replace(/^\/+|\/+$/gu, "");
    return { available: true, basePath: path ? `/${path}` : "/" };
  }

  #closeUi(): void {
    const ui = this.#ui;
    this.#ui = undefined;
    if (ui) {
      const closing = ui.close();
      this.#closingUi.add(closing);
      void closing.then(
        () => this.#closingUi.delete(closing),
        () => this.#closingUi.delete(closing),
      );
    }
  }

  async grants() {
    const grants = await this.#options.state.grants();
    this.#assertCurrent();
    return { grants };
  }

  async pair(assertCommandCurrent?: () => void) {
    assertCommandCurrent?.();
    this.#requireReady();
    const socket = this.#socket;
    const code = createPairingCode();
    const expiresAt = this.#options.scheduler.now() + 10 * 60_000;
    const hash = codeHash(code);
    await this.#options.state.issue(
      hash,
      expiresAt,
      this.#options.scheduler.now(),
      assertCommandCurrent,
    );
    assertCommandCurrent?.();
    this.#requireReady();
    if (socket !== this.#socket) {
      throw new RelayError(
        "unavailable",
        "The relay reconnected. Run openclaw mcp-relay pair again.",
      );
    }
    await this.#request("pair.offer", { codeHash: hash, expiresAt });
    this.#requireReady();
    return { code, expiresAt, mcpUrl: new URL("/mcp", this.#options.relayUrl).href };
  }

  async revoke(grantId: string, assertCommandCurrent?: () => void) {
    assertCommandCurrent?.();
    this.#assertCurrent();
    if (
      !(await this.#options.state.revoke(
        grantId,
        this.#options.scheduler.now(),
        assertCommandCurrent,
      ))
    ) {
      throw new RelayError(
        "not_found",
        "Grant not found. Run openclaw mcp-relay grants and use a listed grant ID.",
      );
    }
    this.#ui?.revoke(grantId);
    this.#assertCurrent();
    if (!this.#ready) {
      return { revoked: true, relayNotified: false };
    }
    try {
      await this.#request("grant.revoke", { grantId });
      return { revoked: true, relayNotified: true };
    } catch {
      // Local revocation is authoritative; reconnect replays durable tombstones.
      return { revoked: true, relayNotified: false };
    }
  }

  #requireReady(): void {
    this.#assertCurrent();
    if (!this.#ready || !this.#socket) {
      throw new RelayError(
        "unavailable",
        "The relay is disconnected. Check openclaw mcp-relay status, then try again.",
      );
    }
  }

  #connect(): void {
    this.#assertCurrent();
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
            handshakeTimeout: 10_000,
          }))
      )(url.href);
    } catch {
      this.#retireConnection(connection);
      this.#retry(0);
      return;
    }
    this.#socket = socket;
    let helloSent = false;
    let activeRequests = 0;
    const current = () =>
      !this.#stopped &&
      !scheduler.signal.aborted &&
      !connection.signal.aborted &&
      this.#socket === socket;
    const assertConnectionCurrent = () => {
      this.#assertCurrent();
      if (!current()) {
        throw new RelayError(
          "unavailable",
          "The relay disconnected. Check openclaw mcp-relay status and try again.",
        );
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
      this.#closeUi();
      this.#retireConnection(connection);
      if (!this.#stopped && !scheduler.signal.aborted) {
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
      if (bytes.byteLength > MAX_FRAME_BYTES) {
        socket.close(1009, "Frame too large");
        return;
      }
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
          this.#send(socket, {
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
          if (frameAncestors && this.#options.controlUiIngress) {
            this.#ui = new UiTunnel({
              factory: this.#options.controlUiIngress,
              frameAncestors,
              scheduler: connection,
              assertGrantCurrent: (grantId) => {
                assertConnectionCurrent();
                this.#options.state.assertGrantCurrent(grantId);
              },
              send: (outgoing) => {
                assertConnectionCurrent();
                this.#send(socket, outgoing);
              },
              bufferedBytes: () => socket.bufferedAmount ?? 0,
              closeRelay: () => socket.terminate(),
              onUnsupportedAuth: (reason) => {
                // The first unsupported launch shows core's error in-frame; later launches fall back.
                this.#unsupportedUi = { config: this.#options.config(), reason };
              },
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
                this.#send(socket, { type: "ping" });
              }
            },
          });
          connection.schedule({
            id: "revocations",
            delayMs: 0,
            run: async () => {
              const grants = await this.#options.state.grants();
              for (const grant of grants) {
                if (!current()) {
                  return;
                }
                if (grant.revokedAt !== undefined) {
                  await this.#request("grant.revoke", { grantId: grant.grantId }).catch(
                    () => undefined,
                  );
                }
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
          this.#send(socket, {
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
          pending.reject(
            new RelayError(
              "unavailable",
              "The relay could not complete the request. Check openclaw mcp-relay status and try again.",
            ),
          );
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
      if (activeRequests >= 32) {
        this.#send(socket, {
          type: "res",
          id,
          ok: false,
          error: { code: "unavailable", message: "OpenClaw is busy. Try again shortly." },
        });
        return;
      }
      activeRequests++;
      connection.schedule({
        id: `request:${++this.#sequence}`,
        delayMs: 0,
        run: async () => {
          try {
            if (!current()) {
              return;
            }
            const result = capResult(await this.#handle(frame, assertConnectionCurrent));
            if (current()) {
              this.#send(socket, { type: "res", id, ok: true, result });
            }
          } catch (error) {
            if (current()) {
              this.#send(socket, { type: "res", id, ok: false, error: safeError(error) });
            }
          } finally {
            activeRequests--;
          }
        },
      });
    });
  }

  #retireConnection(connection: PluginServiceSchedulerV1): void {
    connection.beginClose();
    if (this.#connection === connection) {
      this.#connection = undefined;
    }
    if (!this.#options.scheduler.signal.aborted) {
      // A connection callback cannot join its own scope; its parent owns the join.
      this.#options.scheduler.schedule({
        id: `retire:${++this.#sequence}`,
        delayMs: 0,
        run: () => connection.stop(),
      });
    }
  }

  #retry(closeCode: number): void {
    const base =
      closeCode === 4401 ? 60_000 : Math.min(60_000, 1000 * 2 ** Math.min(this.#attempt++, 6));
    const delayMs = Math.min(
      60_000,
      Math.round(base * (0.8 + (this.#options.random ?? Math.random)() * 0.4)),
    );
    this.#options.scheduler.schedule({ id: "connect", delayMs, run: () => this.#connect() });
  }

  #send(socket: RelaySocket, frame: unknown): void {
    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_FRAME_BYTES) {
      socket.close(1009, "Frame too large");
      return;
    }
    if ((socket.bufferedAmount ?? 0) + (this.#ui?.bufferedBytes ?? 0) + bytes > UI_BUFFER_BYTES) {
      socket.close(1011, "Relay output buffer limit exceeded");
      socket.terminate();
      return;
    }
    socket.send(text);
  }

  #request(op: string, params: Record<string, unknown>): Promise<unknown> {
    this.#requireReady();
    const socket = this.#socket;
    if (!socket || !this.#connection) {
      throw new RelayError("unavailable", "Reconnect the MCP relay and try again.");
    }
    if (this.#pending.size >= 32) {
      throw new RelayError("unavailable", "The relay is busy. Try again shortly.");
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
  ): Promise<unknown> {
    const { op, params } = frame;
    const { state, scheduler } = this.#options;
    if (typeof op !== "string") {
      throw new RelayError("invalid_params", "Supply a valid operation name.");
    }
    if (op !== "grant.create" && op !== "grant.revoked") {
      const { grantId } = frame;
      const assertAuthority = async () => {
        assertConnectionCurrent();
        if (typeof grantId !== "string" || !(await state.authorize(grantId, scheduler.now()))) {
          throw new RelayError(
            "grant_revoked",
            "This connection was revoked. Run openclaw mcp-relay pair and connect again.",
          );
        }
        assertConnectionCurrent();
      };
      await assertAuthority();
      const result = await this.#options.operations(op, params, assertAuthority);
      // Do not publish data after a revocation that raced an awaited SDK read.
      await assertAuthority();
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
      await state.recordRevocation(params.grantId, scheduler.now());
      this.#ui?.revoke(params.grantId);
      return {};
    }
    if (
      Object.keys(params).some((key) => !["grantId", "codeHash", "client"].includes(key)) ||
      typeof params.codeHash !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(params.codeHash) ||
      !isRecord(params.client) ||
      Object.keys(params.client).some((key) => !["id", "name"].includes(key)) ||
      typeof params.client.id !== "string" ||
      !params.client.id ||
      params.client.id.length > 2000 ||
      typeof params.client.name !== "string" ||
      !params.client.name ||
      params.client.name.length > 2000
    ) {
      throw new RelayError(
        "invalid_params",
        "Supply a code hash and client id/name, then retry pairing.",
      );
    }
    if (
      !(await state.createGrant(
        {
          grantId: params.grantId,
          codeHash: params.codeHash,
          client: { id: params.client.id, name: params.client.name },
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
