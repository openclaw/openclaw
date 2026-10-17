import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  attestCodexThreadToolSurface,
  checkCodexThreadAppAvailability,
  discardUnattestedCodexPluginThread,
} from "./plugin-thread-attestation.js";
import type { v2 } from "./protocol.js";
import { createClientHarness } from "./test-support.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";

it.each(["current", "superseded", "aborted"] as const)(
  "skips durable admission for an empty unrestricted surface (%s)",
  async (state) => {
    const h = createClientHarness();
    const failure = new Error("attempt is no longer current");
    const controller = new AbortController();
    const withCurrent = vi.fn(async (consume: () => void) => consume());
    const assertCurrent = vi.fn(() => {
      if (state === "superseded") {
        throw failure;
      }
    });
    if (state === "aborted") {
      controller.abort(failure);
    }
    onTestFinished(() => h.client.close());
    const attestation = attestCodexThreadToolSurface({
      client: h.client,
      threadId: "thread-empty",
      appIds: [],
      restrictedToolSurface: false,
      lifecycleTiming: createCodexThreadLifecycleTimingTracker(),
      signal: controller.signal,
      assertCurrent,
      withCurrent,
    });
    if (state === "current") {
      await expect(attestation).resolves.toBeUndefined();
      expect(assertCurrent).toHaveBeenCalledOnce();
    } else {
      await expect(attestation).rejects.toBe(failure);
    }
    expect(withCurrent).not.toHaveBeenCalled();
    expect(h.writes).toHaveLength(0);
  },
);

function checkApps(
  request: ReturnType<typeof vi.fn>,
  appIds: string[],
  threadId: string,
  signal?: AbortSignal,
) {
  return checkCodexThreadAppAvailability({
    client: { request } as never,
    threadId,
    appIds,
    signal,
  });
}

afterEach(() => vi.restoreAllMocks());

it("records unavailable apps without blocking the remaining tools", async () => {
  const request = vi.fn(async () => ({
    apps: [
      installedApp("working"),
      installedApp("disabled", false, false),
      installedApp("readonly", true, false),
    ],
  }));
  const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
  await checkApps(
    request,
    ["working", "readonly", "missing", "disabled", "missing"],
    "thread-mixed",
  );
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "codex apps unavailable; continuing with remaining tools",
    {
      threadId: "thread-mixed",
      failures: ["disabled:disabled", "missing:missing", "readonly:not-callable"],
    },
  );
  expect(request).toHaveBeenCalledOnce();
});

it("does not read the app snapshot when no apps are configured", async () => {
  const request = vi.fn();
  await checkApps(request, [], "thread-empty");
  expect(request).not.toHaveBeenCalled();
});

it.each(["failure", "abort-resolve", "abort-reject"])(
  "preserves the discovery cause for %s",
  async (outcome) => {
    const abort = new AbortController();
    const cause = new Error("app inventory interrupted");
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    const request = vi.fn(async () => {
      if (outcome !== "failure") {
        abort.abort(cause);
      }
      if (outcome !== "abort-resolve") {
        throw cause;
      }
      return { apps: [] };
    });
    const result = checkApps(request, ["plugin-app"], "thread-unavailable", abort.signal);
    if (outcome === "failure") {
      await expect(result).rejects.toMatchObject({
        name: "CodexPluginThreadAppAttestationError",
        cause,
      });
    } else {
      await expect(result).rejects.toBe(cause);
    }
    expect(warn).not.toHaveBeenCalled();
  },
);
it.each([
  [false, false, true, ["thread/delete"]],
  [true, false, true, ["thread/unsubscribe"]],
  [false, true, false, ["thread/delete", "thread/unsubscribe"]],
] as const)(
  "cleans up ephemeral=%s, failed deletion=%s",
  async (ephemeral, failDelete, result, methods) => {
    const request = vi.fn(async (method: string) => {
      if (failDelete && method === "thread/delete") {
        throw new Error("thread deletion unavailable");
      }
      return {};
    });
    await expect(
      discardUnattestedCodexPluginThread({
        client: { request } as never,
        threadId: "thread-cleanup",
        ephemeral,
      }),
    ).resolves.toBe(result);
    expect(request.mock.calls).toEqual(
      methods.map((method) => [method, { threadId: "thread-cleanup" }, { timeoutMs: 5_000 }]),
    );
  },
);

function installedApp(id: string, enabled = true, callable = true): v2.AppInfo {
  return { id, runtimeName: id, enabled, callable };
}
