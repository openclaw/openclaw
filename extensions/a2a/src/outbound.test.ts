import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { sendA2aChannelText } from "./outbound.js";
import type { A2aCoreConfig, A2aPeerConfig } from "./types.js";

function createA2aOutboundConfig(
  peer: A2aPeerConfig = { token: "inbound-token", url: "https://hermes.example/a2a/v1" },
): A2aCoreConfig {
  return {
    channels: {
      a2a: {
        enabled: true,
        peers: { hermes: peer },
      },
    },
  };
}

function createA2aJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Outbound A2A bodies are always serialized JSON strings; assert that before parsing. */
function parseA2aRequestBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error(`expected a serialized A2A request body, got ${typeof body}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
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
    let current = true;
    const assertDirectAdapterHandoff = vi.fn(() => {
      if (!current) {
        throw new Error("source authority revoked");
      }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      current = false;
      return createA2aJsonResponse({
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not found" },
      });
    });
    const cfg = createA2aOutboundConfig();

    await expect(
      sendA2aChannelText({ cfg, to: "hermes", text: "hello", assertDirectAdapterHandoff }),
    ).rejects.toThrow("source authority revoked");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(assertDirectAdapterHandoff).toHaveBeenCalledTimes(2);
  });

  it("preserves an accepted result when authority closes after request dispatch", async () => {
    let current = true;
    const assertDirectAdapterHandoff = vi.fn(() => {
      if (!current) {
        throw new Error("source authority revoked");
      }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      current = false;
      return createA2aJsonResponse({
        jsonrpc: "2.0",
        result: { task: { id: "accepted-task-1" } },
      });
    });
    const cfg = createA2aOutboundConfig();

    await expect(
      sendA2aChannelText({ cfg, to: "hermes", text: "hello", assertDirectAdapterHandoff }),
    ).resolves.toMatchObject({ messageId: "accepted-task-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(assertDirectAdapterHandoff).toHaveBeenCalledOnce();
  });

  it("retries the legacy dotted method exactly once when canonical dispatch is unavailable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        createA2aJsonResponse({
          jsonrpc: "2.0",
          error: { code: -32601, message: "Method not found" },
        }),
      )
      .mockImplementationOnce(async () => {
        expect(completedReleases).toBe(1);
        return createA2aJsonResponse({
          jsonrpc: "2.0",
          result: { task: { id: "legacy-task-1" } },
        });
      });
    const cfg = createA2aOutboundConfig();
    const assertDirectAdapterHandoff = vi.fn();

    await expect(
      sendA2aChannelText({ cfg, to: "hermes", text: "hello", assertDirectAdapterHandoff }),
    ).resolves.toMatchObject({ messageId: "legacy-task-1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const methods = fetchMock.mock.calls.map(([, init]) => {
      const body = parseA2aRequestBody(init?.body) as { method: string };
      return body.method;
    });
    expect(methods).toEqual(["SendMessage", "message/send"]);
    expect(assertDirectAdapterHandoff).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(firstHeaders).not.toHaveProperty("authorization");
  });

  it("does not retry other JSON-RPC errors or retry the legacy alias repeatedly", async () => {
    const cfg = createA2aOutboundConfig();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createA2aJsonResponse({
        jsonrpc: "2.0",
        error: { code: -32000, message: "peer unavailable" },
      }),
    );

    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "peer unavailable",
    );
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear().mockImplementation(async () =>
      createA2aJsonResponse({
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not found" },
      }),
    );
    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "Method not found",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns its generated message ID when the peer omits a task ID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createA2aJsonResponse({
        jsonrpc: "2.0",
        result: {},
      }),
    );
    const cfg = createA2aOutboundConfig();

    const result = await sendA2aChannelText({ cfg, to: "hermes", text: "hello" });
    const request = parseA2aRequestBody(fetchMock.mock.calls[0]?.[1]?.body) as {
      params: { message: { messageId: string } };
    };
    expect(result.messageId).toBe(request.params.message.messageId);
  });

  it("rejects missing outbound peer URLs before making an HTTP request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cfg = createA2aOutboundConfig({ token: "inbound-token" });

    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "peer hermes has no url configured for outbound A2A",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces transport and malformed peer-response failures", async () => {
    const cfg = createA2aOutboundConfig();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createA2aJsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(createA2aJsonResponse({ error: { code: "invalid" } }))
      .mockResolvedValueOnce(new Response("{invalid JSON"))
      .mockResolvedValueOnce(createA2aJsonResponse({}));

    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "HTTP 503",
    );
    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "invalid A2A JSON-RPC response",
    );
    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "peer hermes A2A response: malformed JSON response",
    );
    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "A2A response without a result",
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("bounds oversized peer JSON responses before parsing", async () => {
    const cfg = createA2aOutboundConfig();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createA2aJsonResponse({
        jsonrpc: "2.0",
        result: { task: { id: "remote-task-1" } },
        padding: "x".repeat(16 * 1024 * 1024),
      }),
    );

    await expect(sendA2aChannelText({ cfg, to: "hermes", text: "hello" })).rejects.toThrow(
      "peer hermes A2A response: JSON response exceeds 16777216 bytes",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
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

    const failure = await sendA2aChannelText({ cfg, to: "hermes", text: "hello" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected malformed peer response to reject");
    }
    expect(failure.message).toBe("peer hermes A2A response: malformed JSON response");
    expect(failure.message).not.toContain(outboundToken);
    expect(String(failure.cause)).not.toContain(outboundToken);
    expect(failure.cause).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
