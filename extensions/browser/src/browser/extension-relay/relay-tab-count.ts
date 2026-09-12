import http from "node:http";
import net from "node:net";
import {
  createRelayProof,
  isCanonicalBase64UrlBytes,
  randomRelayNonce,
  relayKeyIdFromHex,
  verifyRelayProof,
  type BrowserRelayProofFields,
} from "./auth-v2-crypto.js";
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
  BROWSER_RELAY_CHALLENGE_TTL_MS,
  parseStrictJsonObject,
} from "./auth-v2.js";

/** Count granted tabs without opening CDP or attaching the Chrome debugger. */
export async function countExtensionRelayTabs(params: {
  port: number;
  token: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<number> {
  if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65535) {
    throw new Error("Invalid extension relay port");
  }
  const deadline = new AbortController();
  const signal = AbortSignal.any([params.signal, deadline.signal]);
  signal.throwIfAborted();
  const timer = setTimeout(
    () => deadline.abort(new Error("Extension relay tab count timed out")),
    params.timeoutMs ?? BROWSER_RELAY_CHALLENGE_TTL_MS,
  );
  timer.unref();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let connected = false;
  // The proof authenticates a socket, not a pool. Never replay any handshake
  // step on a replacement connection, even if the listener closes keep-alive.
  agent.createConnection = (_options, callback) => {
    if (connected) {
      const closed = new net.Socket();
      queueMicrotask(() =>
        callback?.(new Error("Extension relay authentication connection closed"), closed),
      );
      return undefined;
    }
    connected = true;
    return net.createConnection({ host: "127.0.0.1", port: params.port, signal });
  };
  const abort = () => agent.destroy();
  signal.addEventListener("abort", abort, { once: true });
  const request = (path: string, body?: object): Promise<string> =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const content = body === undefined ? "" : JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: params.port,
          path,
          method: body === undefined ? "GET" : "POST",
          agent,
          signal,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(content),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("error", reject);
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) {
              res.destroy(new Error("Extension relay response is too large"));
            } else {
              chunks.push(chunk);
            }
          });
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Extension relay HTTP ${res.statusCode}`));
              return;
            }
            resolve(Buffer.concat(chunks).toString("utf8"));
          });
        },
      );
      req.on("error", reject);
      req.end(content);
    });
  try {
    const keyId = relayKeyIdFromHex(params.token);
    const clientNonce = randomRelayNonce();
    const binding = {
      role: "cdp",
      transport: "connection",
      method: "GET",
      resource: "/json/list",
      flow: "json-list",
    } as const;
    const challenge = parseStrictJsonObject(
      await request(BROWSER_RELAY_AUTH_CHALLENGE_PATH, {
        v: 2,
        keyId,
        clientNonce,
        ...binding,
      }),
    );
    const now = Date.now();
    if (
      !challenge ||
      Object.keys(challenge).length !== 15 ||
      challenge.type !== "auth.challenge" ||
      challenge.v !== 2 ||
      challenge.keyId !== keyId ||
      challenge.clientNonce !== clientNonce ||
      Object.entries(binding).some(([key, value]) => challenge[key] !== value) ||
      !isCanonicalBase64UrlBytes(challenge.instanceId, 16) ||
      !isCanonicalBase64UrlBytes(challenge.sessionId, 16) ||
      !isCanonicalBase64UrlBytes(challenge.serverNonce, 32) ||
      typeof challenge.issuedAtMs !== "number" ||
      !Number.isSafeInteger(challenge.issuedAtMs) ||
      typeof challenge.expiresAtMs !== "number" ||
      !Number.isSafeInteger(challenge.expiresAtMs) ||
      challenge.expiresAtMs <= now ||
      challenge.issuedAtMs > now + 30_000 ||
      challenge.expiresAtMs - challenge.issuedAtMs !== BROWSER_RELAY_CHALLENGE_TTL_MS
    ) {
      throw new Error("Extension relay tab count authentication binding mismatch");
    }
    const fields: BrowserRelayProofFields = {
      keyId,
      clientNonce,
      ...binding,
      instanceId: challenge.instanceId,
      sessionId: challenge.sessionId,
      serverNonce: challenge.serverNonce,
      issuedAtMs: challenge.issuedAtMs,
      expiresAtMs: challenge.expiresAtMs,
    };
    if (!verifyRelayProof(params.token, "server", fields, challenge.serverProof)) {
      throw new Error("Extension relay did not prove the configured key");
    }
    const clientProof = createRelayProof(params.token, "client", fields);
    const accepted = parseStrictJsonObject(
      await request(BROWSER_RELAY_AUTH_COMPLETE_PATH, {
        v: 2,
        sessionId: fields.sessionId,
        clientProof,
      }),
    );
    if (
      !accepted ||
      Object.keys(accepted).length !== 4 ||
      accepted.type !== "auth.ok" ||
      accepted.v !== 2 ||
      accepted.sessionId !== fields.sessionId ||
      !verifyRelayProof(params.token, "accept", fields, accepted.acceptProof, clientProof)
    ) {
      throw new Error("Extension relay acceptance proof failed");
    }
    const tabs: unknown = JSON.parse(await request("/json/list"));
    if (!Array.isArray(tabs)) {
      throw new Error("Invalid extension relay tab inventory");
    }
    signal.throwIfAborted();
    return tabs.filter((tab) => tab !== null && typeof tab === "object" && tab.type === "page")
      .length;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    agent.destroy();
  }
}
