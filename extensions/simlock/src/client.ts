import { randomUUID } from "node:crypto";

export class SimlockError extends Error {
  readonly code: string;
  readonly noEffect: boolean;
  constructor(code: string, message: string, noEffect = false) {
    super(message);
    this.name = "SimlockError";
    this.code = code;
    this.noEffect = noEffect;
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SimlockError("PROTOCOL", "Simlock returned an incompatible response.");
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512) {
    throw new SimlockError("PROTOCOL", "Simlock returned an incompatible response.");
  }
  return value;
}

export type Invocation = { assertCurrent: () => void; signal?: AbortSignal };
export type Config = { gatewayUrl: string; token: string };

export function parseConfig(value: unknown): Config {
  const input = record(value);
  if (typeof input.token !== "string" || !input.token.trim() || /[\r\n]/.test(input.token)) {
    throw new SimlockError("CONFIG", "Configure a resolved Simlock agent-token SecretRef.");
  }
  let url: URL;
  try {
    url = new URL(String(input.gatewayUrl));
  } catch {
    throw new SimlockError("CONFIG", "Configure an absolute Simlock gateway origin.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new SimlockError(
      "CONFIG",
      "Use a Simlock HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }
  return { gatewayUrl: url.origin, token: input.token };
}

/** Fixed-origin transport: no redirects, remote error text, or server paths escape. */
export class SimlockClient {
  constructor(
    private readonly config: Config,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(
    path: string,
    invocation: Invocation,
    body?: unknown,
    leaseId?: string,
    image = false,
    method?: "DELETE",
  ): Promise<unknown> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(15_000),
      ...(invocation.signal ? [invocation.signal] : []),
    ]);
    const headers: Record<string, string> = { Authorization: "Bearer " + this.config.token };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (leaseId) {
      headers["x-agent-device-lease-id"] = leaseId;
    }
    let dispatched = false;
    try {
      signal.throwIfAborted();
      invocation.assertCurrent();
      dispatched = true;
      const response = await this.fetcher(this.config.gatewayUrl + path, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new SimlockError(
          response.status === 401 || response.status === 403
            ? "AUTH"
            : response.status === 404
              ? "NOT_FOUND"
              : "HTTP",
          "Simlock rejected the request. Check gateway access and lease status.",
        );
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (!reader) {
        throw new SimlockError("PROTOCOL", "Simlock returned an empty response.");
      }
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) {
            break;
          }
          size += next.value.byteLength;
          if (size > (image ? 10 * 1024 * 1024 : 1024 * 1024)) {
            await reader.cancel();
            throw new SimlockError("TOO_LARGE", "Simlock response exceeded the plugin size limit.");
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      signal.throwIfAborted();
      invocation.assertCurrent();
      const bytes = Buffer.concat(chunks);
      if (image) {
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          throw new SimlockError("PROTOCOL", "Simlock did not return a PNG screenshot.");
        }
        return bytes;
      }
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof SimlockError) {
        throw error;
      }
      if (signal.aborted) {
        throw new SimlockError(
          "CANCELLED",
          "Simlock request cancelled or timed out. Check lease status before retrying.",
          !dispatched,
        );
      }
      // Before dispatch there is provably no remote effect; after dispatch the outcome stays uncertain.
      throw new SimlockError(
        "UNAVAILABLE",
        "Simlock request failed or tool authority changed. Check status before retrying.",
        !dispatched,
      );
    }
  }

  redact(value: string, secrets: string[]): string {
    return [this.config.token, this.config.gatewayUrl, ...secrets]
      .filter((secret) => secret.length > 3)
      .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
  }

  async health(invocation: Invocation) {
    const health = record(await this.request("/v1/agent-device/health", invocation));
    if (
      health.ok !== true ||
      health.service !== "agent-device-proxy" ||
      health.rpcProtocolVersion !== 2
    ) {
      throw new SimlockError(
        "INCOMPATIBLE",
        "Simlock agent-device protocol 2 is unavailable. Check its configured capability and daemon.",
      );
    }
    return { protocol: 2 as const };
  }

  async status(invocation: Invocation) {
    return record(await this.request("/v1/status", invocation));
  }

  async rpc(
    method: "allocate" | "heartbeat" | "release" | "command",
    params: Record<string, unknown>,
    invocation: Invocation,
  ) {
    const id = randomUUID();
    const reply = record(
      await this.request("/v1/agent-device/rpc", invocation, {
        jsonrpc: "2.0",
        id,
        method: "agent_device." + (method === "command" ? "command" : "lease." + method),
        params,
      }),
    );
    if (reply.id !== id || reply.jsonrpc !== "2.0") {
      throw new SimlockError("PROTOCOL", "Simlock returned an incompatible RPC envelope.");
    }
    if (reply.error !== undefined) {
      throw new SimlockError(
        "RPC",
        "Simlock refused the operation. Check lease status; no replacement device was requested.",
      );
    }
    const result = record(reply.result);
    if (result.ok !== true) {
      throw new SimlockError("RPC", "Simlock reported an unsuccessful operation.");
    }
    return record(result.data);
  }

  async releasePool(leaseId: string, invocation: Invocation) {
    const reply = record(
      await this.request(
        "/v1/leases/" + encodeURIComponent(leaseId),
        invocation,
        undefined,
        undefined,
        false,
        "DELETE",
      ),
    );
    if (reply.released !== true) {
      throw new SimlockError(
        "PROTOCOL",
        "Simlock did not confirm lease release. Check status before retrying.",
      );
    }
  }

  async screenshot(artifactId: string, leaseId: string, invocation: Invocation): Promise<Buffer> {
    const result = await this.request(
      "/v1/agent-device/artifacts/" + encodeURIComponent(artifactId),
      invocation,
      undefined,
      leaseId,
      true,
    );
    if (!Buffer.isBuffer(result)) {
      throw new SimlockError("PROTOCOL", "Simlock returned an invalid screenshot.");
    }
    return result;
  }
}
