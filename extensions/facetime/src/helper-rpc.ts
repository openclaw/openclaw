import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { formatErrorMessage } from "./errors.js";
import type { FaceTimeDialRequest } from "./outbound-call.js";

type HelperSocketServerParams = {
  host: string;
  port: number;
  logger: RuntimeLogger;
  ipcKey: string;
  buildId: string;
  onMessage: (message: unknown) => void;
  onConnect?: (bundleIdentifier: string) => void;
  onDisconnect?: (bundleIdentifier: string) => void;
  onStale?: (bundleIdentifier: string, processId: number) => void;
};

export type HelperActionResult = Record<string, unknown>;

const FACETIME_DIAL_HELPER_BUNDLES = new Set([
  "com.apple.FaceTime",
  "com.apple.FaceTime.FTConversationService",
]);
const FACETIME_HELPER_BUNDLES = new Set([
  ...FACETIME_DIAL_HELPER_BUNDLES,
  "com.apple.mobilephone",
  "com.apple.TelephonyUtilities",
]);

function helperHmac(ipcKey: string, message: string): string {
  return createHmac("sha256", ipcKey).update(message).digest("hex");
}

function secureStringsEqual(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return (
    firstBuffer.length > 0 &&
    firstBuffer.length === secondBuffer.length &&
    timingSafeEqual(firstBuffer, secondBuffer)
  );
}

export class FaceTimeHelperActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaceTimeHelperActionError";
  }
}

export class FaceTimeHelperAmbiguousError extends Error {
  constructor(
    message: string,
    readonly result: HelperActionResult = {},
  ) {
    super(message);
    this.name = "FaceTimeHelperAmbiguousError";
  }
}

export class FaceTimeHelperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaceTimeHelperUnavailableError";
  }
}

type PendingRpc = {
  resolve: (result: HelperActionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class FaceTimeHelperSocketServer {
  readonly #server: net.Server;
  readonly #sockets = new Set<net.Socket>();
  readonly #socketBundleIdentifiers = new Map<net.Socket, string>();
  readonly #socketAuthChallenges = new Map<net.Socket, string>();
  readonly #socketAuthSessions = new Map<net.Socket, string>();
  readonly #pending = new Map<string, PendingRpc>();
  readonly #logger: RuntimeLogger;
  #started = false;

  constructor(private readonly params: HelperSocketServerParams) {
    this.#logger = params.logger;
    this.#server = net.createServer((socket) => this.#handleSocket(socket));
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off("error", onError);
        this.#started = true;
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.params.port, this.params.host);
    });
  }

  async stop(): Promise<void> {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("helper socket server stopped"));
    }
    this.#pending.clear();
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    if (!this.#started) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
    this.#started = false;
  }

  async answerCall(callUUID: string): Promise<HelperActionResult> {
    return await this.#sendActionToAll("answer-call", { callUUID });
  }

  async startCall(
    request: FaceTimeDialRequest,
    dialID: string,
    requestedAt: string,
  ): Promise<HelperActionResult> {
    return await this.#sendAction("start-call", { ...request, dialID, requestedAt });
  }

  async findOutgoingCall(
    handle: string,
    callUUID?: string,
    dialID?: string,
    proxyIdentifier?: string,
    requestedAt?: string,
    mode?: FaceTimeDialRequest["mode"],
  ): Promise<HelperActionResult> {
    return await this.#sendActionToAll("find-outgoing-call", {
      handle,
      ...(callUUID ? { callUUID } : {}),
      ...(dialID ? { dialID } : {}),
      ...(proxyIdentifier ? { proxyIdentifier } : {}),
      ...(requestedAt ? { requestedAt } : {}),
      ...(mode ? { mode } : {}),
    });
  }

  async cancelOutgoingCall(params: {
    dialID: string;
    handle: string;
    callUUID?: string;
    proxyIdentifier?: string;
    requestedAt?: string;
    mode?: FaceTimeDialRequest["mode"];
  }): Promise<HelperActionResult> {
    return await this.#sendActionToAll("cancel-outgoing-call", params);
  }

  async leaveCall(callUUID: string): Promise<HelperActionResult> {
    return await this.#sendActionToAll("leave-call", { callUUID });
  }

  async safetyMute(callUUID: string): Promise<HelperActionResult> {
    return await this.#sendActionToAll("safety-mute", { callUUID });
  }

  async setMuted(callUUID: string, muted: boolean): Promise<HelperActionResult> {
    return await this.#sendActionToAll("set-muted", { callUUID, muted });
  }

  async startTransmission(callUUID: string): Promise<HelperActionResult> {
    return await this.#sendActionToAll("start-transmission", { callUUID });
  }

  get connectedSockets(): number {
    return this.#socketBundleIdentifiers.size;
  }

  get connectedHelperBundles(): string[] {
    return [...new Set(this.#socketBundleIdentifiers.values())];
  }

  #handleSocket(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.search(/\r?\n/);
        if (newline < 0) {
          break;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(buffer[newline] === "\r" ? newline + 2 : newline + 1);
        if (line) {
          this.#handleLine(socket, line);
        }
      }
    });
    socket.on("error", (error) => {
      this.#logger.debug?.(`[facetime] helper socket error: ${formatErrorMessage(error)}`);
    });
    socket.on("close", () => {
      const disconnectedBundle = this.#socketBundleIdentifiers.get(socket);
      this.#sockets.delete(socket);
      this.#socketBundleIdentifiers.delete(socket);
      this.#socketAuthChallenges.delete(socket);
      this.#socketAuthSessions.delete(socket);
      if (disconnectedBundle) {
        this.params.onDisconnect?.(disconnectedBundle);
      }
    });
  }

  #handleLine(socket: net.Socket, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.#logger.debug?.(`[facetime] ignored invalid helper JSON: ${formatErrorMessage(error)}`);
      return;
    }
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    if (record.event === "ping") {
      const nonce = randomUUID();
      this.#socketAuthChallenges.set(socket, nonce);
      socket.write(`${JSON.stringify({ event: "auth-challenge", nonce })}\r\n`);
      return;
    } else if (record.event === "auth-response") {
      const bundleIdentifier =
        typeof record.bundle_identifier === "string" ? record.bundle_identifier.trim() : "";
      const nonce = typeof record.nonce === "string" ? record.nonce : "";
      const receivedAuth = typeof record.auth === "string" ? record.auth : "";
      const buildId = typeof record.build_id === "string" ? record.build_id.trim() : "";
      const processId =
        typeof record.process_id === "number" && Number.isSafeInteger(record.process_id)
          ? record.process_id
          : 0;
      const expectedNonce = this.#socketAuthChallenges.get(socket);
      const expectedAuth = helperHmac(
        this.params.ipcKey,
        `helper\n${bundleIdentifier}\n${nonce}\n${buildId}\n${processId}`,
      );
      const legacyAuth = helperHmac(this.params.ipcKey, `helper\n${bundleIdentifier}\n${nonce}`);
      const authenticatedCurrentShape =
        processId > 0 && secureStringsEqual(receivedAuth, expectedAuth);
      const authenticatedLegacyShape =
        buildId === "" && processId === 0 && secureStringsEqual(receivedAuth, legacyAuth);
      if (
        expectedNonce === nonce &&
        FACETIME_HELPER_BUNDLES.has(bundleIdentifier) &&
        (authenticatedCurrentShape || authenticatedLegacyShape)
      ) {
        if (authenticatedLegacyShape || buildId !== this.params.buildId) {
          this.#socketAuthChallenges.delete(socket);
          this.params.onStale?.(bundleIdentifier, processId);
          socket.destroy();
          return;
        }
        const wasAuthenticated = this.#socketBundleIdentifiers.has(socket);
        this.#socketBundleIdentifiers.set(socket, bundleIdentifier);
        this.#socketAuthSessions.set(socket, nonce);
        this.#socketAuthChallenges.delete(socket);
        if (!wasAuthenticated) {
          this.params.onConnect?.(bundleIdentifier);
        }
      }
      return;
    }
    if (!this.#socketBundleIdentifiers.has(socket)) {
      this.#logger.warn?.("[facetime] ignored message from unauthenticated helper socket");
      return;
    }
    const transactionId = typeof record.transactionId === "string" ? record.transactionId : "";
    if (transactionId && this.#pending.has(transactionId)) {
      const pending = this.#pending.get(transactionId);
      this.#pending.delete(transactionId);
      if (pending) {
        clearTimeout(pending.timeout);
        if (typeof record.error === "string" && record.error) {
          pending.reject(
            record.ambiguous === true
              ? new FaceTimeHelperAmbiguousError(record.error, record)
              : new FaceTimeHelperActionError(record.error),
          );
        } else {
          pending.resolve(record);
        }
      }
      return;
    }
    this.params.onMessage(parsed);
  }

  async #sendAction(action: string, data: Record<string, unknown>): Promise<HelperActionResult> {
    const socket = [...this.#sockets].find(
      (candidate) =>
        !candidate.destroyed &&
        FACETIME_DIAL_HELPER_BUNDLES.has(this.#socketBundleIdentifiers.get(candidate) ?? ""),
    );
    if (!socket) {
      throw new FaceTimeHelperUnavailableError(
        "Authenticated FaceTime dialing helper is not connected to the facetime event socket",
      );
    }
    return await this.#sendActionOnSocket(socket, action, data);
  }

  async #sendActionToAll(
    action: string,
    data: Record<string, unknown>,
  ): Promise<HelperActionResult> {
    const sockets = [...this.#sockets].filter(
      (candidate) =>
        !candidate.destroyed &&
        FACETIME_HELPER_BUNDLES.has(this.#socketBundleIdentifiers.get(candidate) ?? ""),
    );
    if (sockets.length === 0) {
      throw new FaceTimeHelperUnavailableError(
        "FaceTime helper is not connected to the facetime event socket",
      );
    }
    const results = await Promise.allSettled(
      sockets.map((socket) => this.#sendActionOnSocket(socket, action, data)),
    );
    const fulfilled = results.flatMap((result, index) =>
      result.status === "fulfilled"
        ? [
            {
              ...result.value,
              helperBundleIdentifier:
                this.#socketBundleIdentifiers.get(sockets[index]) ?? "unknown",
            },
          ]
        : [],
    );
    if (fulfilled.length > 0) {
      return {
        helpersContacted: sockets.length,
        helperResults: fulfilled,
        ...fulfilled[fulfilled.length - 1],
      };
    }
    const firstRejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw firstRejected?.reason instanceof Error
      ? firstRejected.reason
      : new Error(`FaceTime helper action failed: ${action}`);
  }

  async #sendActionOnSocket(
    socket: net.Socket,
    action: string,
    data: Record<string, unknown>,
  ): Promise<HelperActionResult> {
    const transactionId = randomUUID();
    const authNonce = randomUUID();
    const authSession = this.#socketAuthSessions.get(socket);
    if (!authSession) {
      throw new FaceTimeHelperUnavailableError("FaceTime helper socket is not authenticated");
    }
    const dataJSON = JSON.stringify(data);
    const auth = helperHmac(
      this.params.ipcKey,
      `action\n${action}\n${transactionId}\n${authSession}\n${authNonce}\n${dataJSON}`,
    );
    const payload = JSON.stringify({
      action,
      transactionId,
      auth_session: authSession,
      auth_nonce: authNonce,
      data,
      data_json: dataJSON,
      auth,
    });
    return await new Promise<HelperActionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(transactionId);
        reject(new Error(`FaceTime helper action timed out: ${action}`));
      }, 5_000);
      this.#pending.set(transactionId, { resolve, reject, timeout });
      socket.write(`${payload}\r\n`, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        this.#pending.delete(transactionId);
        reject(error);
      });
    });
  }
}
