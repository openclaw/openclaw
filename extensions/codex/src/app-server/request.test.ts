import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedClientMocks = vi.hoisted(() => ({
  createIsolatedCodexAppServerClient: vi.fn(),
  getSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./shared-client.js", () => sharedClientMocks);

const { requestCodexAppServerJson } = await import("./request.js");

describe("requestCodexAppServerJson sandbox guard", () => {
  beforeEach(() => {
    sharedClientMocks.createIsolatedCodexAppServerClient.mockReset();
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
  });

  it("fails closed before raw app-server bypass methods in sandboxed sessions", async () => {
    await expect(
      requestCodexAppServerJson({
        method: "command/exec",
        requestParams: { command: ["sh", "-lc", "id"] },
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).rejects.toThrow(
      "Codex-native app-server method `command/exec` is unavailable because OpenClaw sandboxing is active for this session.",
    );

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("allows metadata methods in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

    await expect(
      requestCodexAppServerJson({
        method: "thread/list",
        requestParams: { limit: 10 },
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledWith(
      "thread/list",
      { limit: 10 },
      { timeoutMs: 60_000, signal: expect.any(AbortSignal) },
    );
  });

  it("allows sandbox-pinned thread starts in sandboxed sessions", async () => {
    const request = vi.fn(async () => ({ thread: { id: "thread-1" }, model: "gpt-5.5" }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const params = {
      cwd: "/workspace",
      environments: [{ environmentId: "openclaw-sandbox-abc123", cwd: "/workspace" }],
    };

    await expect(
      requestCodexAppServerJson({
        method: "thread/start",
        requestParams: params,
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      }),
    ).resolves.toEqual({ thread: { id: "thread-1" }, model: "gpt-5.5" });

    expect(request).toHaveBeenCalledWith(
      "thread/start",
      params,
      { timeoutMs: 60_000, signal: expect.any(AbortSignal) },
    );
  });
});

describe("requestCodexAppServerJson timeout", () => {
  beforeEach(() => {
    sharedClientMocks.createIsolatedCodexAppServerClient.mockReset();
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
  });

  it("calls closeAndWait when client.request hangs and times out in an isolated request", async () => {
    const request = vi.fn((_method, _params, options?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(options.signal.reason ?? new Error("aborted"));
          return;
        }
        options?.signal?.addEventListener("abort", () => {
          reject(options.signal?.reason ?? new Error("aborted"));
        });
      });
    });
    const closeAndWait = vi.fn(async () => undefined);
    const client = { request, closeAndWait };
    sharedClientMocks.createIsolatedCodexAppServerClient.mockResolvedValue(client);

    await expect(
      requestCodexAppServerJson({
        method: "item/tool/call",
        requestParams: {},
        timeoutMs: 10,
        isolated: true,
      }),
    ).rejects.toThrow("codex app-server item/tool/call timed out");

    expect(closeAndWait).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "item/tool/call",
      {},
      {
        timeoutMs: 10,
        signal: expect.any(AbortSignal),
      },
    );
  });
});
