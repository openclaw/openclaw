import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withEnv, withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { sendA2aChannelText } from "./outbound.js";
import type { A2aCoreConfig, A2aPeerConfig } from "./types.js";

function createA2aOutboundConfig(
  peer: A2aPeerConfig = { token: "inbound-token", url: "https://hermes.example/a2a/v1" },
): A2aCoreConfig {
  return { channels: { a2a: { enabled: true, peers: { hermes: peer } } } };
}

/** Outbound A2A bodies are always serialized JSON strings; assert that before parsing. */
function parseA2aRequestBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error(`expected a serialized A2A request body, got ${typeof body}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

const send = (
  cfg: A2aCoreConfig = createA2aOutboundConfig(),
  assertDirectAdapterHandoff?: () => void,
) => sendA2aChannelText({ cfg, to: "hermes", text: "hello", assertDirectAdapterHandoff });
const rpcError = (code = -32601, message = "Method not found") =>
  Response.json({ jsonrpc: "2.0", error: { code, message } });
const rpcTask = (id: string) => Response.json({ jsonrpc: "2.0", result: { task: { id } } });

function revokeDuringFetch(response: Response) {
  let current = true;
  const handoff = vi.fn(() => {
    if (!current) {
      throw new Error("source authority revoked");
    }
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
    current = false;
    return response;
  });
  return { handoff, fetch };
}

const guardedFetch = ssrfRuntime.fetchWithSsrFGuard;
const releases: { release: Mock<() => Promise<void>>; cleanup: () => Promise<void> }[] = [];
let completedReleases = 0;

async function trackGuardedFetch(params: Parameters<typeof guardedFetch>[0]) {
  const result = await guardedFetch(params);
  const release = vi.fn(async () => {
    await result.release();
    completedReleases += 1;
  });
  releases.push({ release, cleanup: result.release });
  return { ...result, release };
}

beforeEach(() => {
  releases.length = 0;
  completedReleases = 0;
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(trackGuardedFetch);
});

afterEach(async () => {
  try {
    for (const { release } of releases) {
      expect(release).toHaveBeenCalledOnce();
    }
    expect(completedReleases).toBe(releases.length);
  } finally {
    try {
      // Failed lifecycle assertions must still dispose the real guard timers.
      await Promise.all(releases.map(({ cleanup }) => cleanup()));
    } finally {
      vi.restoreAllMocks();
    }
  }
});

describe("A2A outbound channel delivery", () => {
  it("rechecks handoff authority before the compatibility retry", async () => {
    const { handoff, fetch } = revokeDuringFetch(rpcError());

    await expect(send(undefined, handoff)).rejects.toThrow("source authority revoked");
    expect(fetch).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledTimes(2);
  });

  it("preserves an accepted result when authority closes after request dispatch", async () => {
    const { handoff, fetch } = revokeDuringFetch(rpcTask("accepted-task-1"));

    await expect(send(undefined, handoff)).resolves.toMatchObject({
      messageId: "accepted-task-1",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledOnce();
  });

  it("retries the legacy dotted method exactly once when canonical dispatch is unavailable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(rpcError())
      .mockImplementationOnce(async () => {
        expect(completedReleases).toBe(1);
        return rpcTask("legacy-task-1");
      });
    const assertDirectAdapterHandoff = vi.fn();

    await expect(send(undefined, assertDirectAdapterHandoff)).resolves.toMatchObject({
      messageId: "legacy-task-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const methods = fetchMock.mock.calls.map(([, init]) => parseA2aRequestBody(init?.body).method);
    expect(methods).toEqual(["SendMessage", "message/send"]);
    expect(assertDirectAdapterHandoff).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
  });

  it.each([
    [-32000, "peer unavailable", 1],
    [-32601, "Method not found", 2],
  ] as const)("bounds retries for RPC error %s", async (code, message, attempts) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => rpcError(code, message));
    await expect(send()).rejects.toThrow(message);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
  });

  it("returns its generated message ID when the peer omits a task ID", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ jsonrpc: "2.0", result: {} }));

    const result = await send();
    const request = parseA2aRequestBody(fetchMock.mock.calls[0]?.[1]?.body) as {
      params: { message: { messageId: string } };
    };
    expect(result.messageId).toBe(request.params.message.messageId);
  });

  it("reads a direct message reply that creates no task", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        jsonrpc: "2.0",
        result: {
          message: { messageId: "msg-direct", contextId: "ctx-direct", role: "ROLE_AGENT" },
        },
      }),
    );

    // §7.1: SendMessage succeeds with either branch of the oneof, and a peer that
    // answers directly has no task to correlate against.
    const result = await send();
    expect(result).toMatchObject({ messageId: "msg-direct", contextId: "ctx-direct" });
    expect(result).not.toHaveProperty("taskId");
    expect(result).not.toHaveProperty("state");
  });

  it("reports the peer task state so interrupted tasks are distinguishable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        jsonrpc: "2.0",
        result: {
          task: {
            id: "task-7",
            contextId: "ctx-7",
            status: { state: "TASK_STATE_INPUT_REQUIRED" },
          },
        },
      }),
    );

    // An accepted-but-unfinished task must not look like a completed fire-and-forget send.
    await expect(send()).resolves.toMatchObject({
      messageId: "task-7",
      taskId: "task-7",
      contextId: "ctx-7",
      state: "TASK_STATE_INPUT_REQUIRED",
    });
  });

  it("prefers the stable ErrorInfo reason when the peer rejects the send", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        jsonrpc: "2.0",
        error: {
          code: -32002,
          message: "cannot cancel now",
          data: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "TASK_NOT_CANCELABLE",
              domain: "a2a-protocol.org",
            },
          ],
        },
      }),
    );

    await expect(send()).rejects.toThrow(/cannot cancel now \[TASK_NOT_CANCELABLE\]/);
  });

  it("rejects missing outbound peer URLs before making an HTTP request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cfg = createA2aOutboundConfig({ token: "inbound-token" });

    await expect(send(cfg)).rejects.toThrow("peer hermes has no url configured for outbound A2A");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces transport and malformed peer-response failures", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: { code: "invalid" } }))
      .mockResolvedValueOnce(new Response("{invalid JSON"))
      .mockResolvedValueOnce(Response.json({}));

    await expect(send()).rejects.toThrow("HTTP 503");
    await expect(send()).rejects.toThrow("invalid A2A JSON-RPC response");
    await expect(send()).rejects.toThrow("peer hermes A2A response: malformed JSON response");
    await expect(send()).rejects.toThrow("A2A response without a result");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retain reflected outbound credentials in malformed responses", async () => {
    const outboundToken = "outbound-secret-token";
    const cfg = createA2aOutboundConfig({
      token: "inbound-token",
      outboundToken,
      url: "https://hermes.example/a2a/v1",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(`{"reflected":"${outboundToken}"`, {
        headers: { "content-type": "application/json" },
      }),
    );

    const failure = await send(cfg).catch((error: unknown) => error);

    if (!(failure instanceof Error)) {
      throw new Error("expected malformed peer response to reject");
    }
    expect(failure.message).toBe("peer hermes A2A response: malformed JSON response");
    expect(failure.cause).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("refuses to send, and performs no network I/O, when the authored outboundToken did not resolve", async () => {
    await withStateDirEnv("a2a-outbound-unresolved-", async ({ stateDir }) => {
      const configPath = path.join(stateDir, "openclaw.json");
      const peer = {
        token: "inbound-token",
        url: "https://hermes.example/a2a/v1",
        outboundToken: "${OPENCLAW_A2A_OUTBOUND_TEST_UNSET}",
      };
      fs.writeFileSync(
        configPath,
        JSON.stringify({ channels: { a2a: { peers: { hermes: peer } } } }),
      );
      const cfg = withEnv(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_A2A_OUTBOUND_TEST_UNSET: undefined },
        () => getRuntimeConfig({ pin: false }),
      );

      await expect(sendA2aChannelText({ cfg, to: "a2a:hermes", text: "hello" })).rejects.toThrow(
        /outboundToken reference did not resolve/,
      );
      expect(ssrfRuntime.fetchWithSsrFGuard).not.toHaveBeenCalled();
    });
  });
});
