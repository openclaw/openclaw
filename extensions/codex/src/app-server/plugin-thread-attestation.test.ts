import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  attestCodexThreadToolSurface,
  checkCodexThreadAppAvailability,
  discardUnattestedCodexPluginThread,
} from "./plugin-thread-attestation.js";
import type { v2 } from "./protocol.js";
import { createClientHarness } from "./test-support.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";

describe("Codex thread tool-surface admission", () => {
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
});

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

describe("Codex thread app availability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records unavailable apps without blocking the remaining tools", async () => {
    const request = vi.fn(async () => ({
      apps: [
        ...installedApps(["working"]).apps,
        ...installedApps(["disabled"], { enabled: false, callable: false }).apps,
        ...installedApps(["readonly"], { callable: false }).apps,
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

  it("preserves snapshot request failures and their cause", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    const cause = new Error("app inventory offline");
    const request = vi.fn(async () => {
      throw cause;
    });
    await expect(checkApps(request, ["plugin-app"], "thread-unavailable")).rejects.toMatchObject({
      name: "CodexPluginThreadAppAttestationError",
      cause,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])(
    "preserves cancellation when discovery will %s",
    async (outcome) => {
      const abort = new AbortController();
      const cause = new Error("turn cancelled");
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const request = vi.fn(async () => {
        abort.abort(cause);
        if (outcome === "reject") {
          throw cause;
        }
        return installedApps([]);
      });
      await expect(
        checkApps(request, ["plugin-app"], "thread-cancelled", abort.signal),
      ).rejects.toBe(cause);
      expect(warn).not.toHaveBeenCalled();
    },
  );
});

describe("unattested Codex plugin thread cleanup", () => {
  it.each([
    { ephemeral: false, method: "thread/delete" },
    { ephemeral: true, method: "thread/unsubscribe" },
  ])("cleans up an unattested thread with $method", async ({ ephemeral, method }) => {
    const request = vi.fn(async () => ({}));
    await expect(
      discardUnattestedCodexPluginThread({
        client: { request } as never,
        threadId: "thread-cleanup",
        ephemeral,
      }),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      method,
      { threadId: "thread-cleanup" },
      { timeoutMs: 5_000 },
    );
  });

  it("does not treat unsubscribe as proof that a persistent thread was deleted", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/delete") {
        throw new Error("thread deletion unavailable");
      }
      return {};
    });

    await expect(
      discardUnattestedCodexPluginThread({
        client: { request } as never,
        threadId: "thread-persistent",
        ephemeral: false,
      }),
    ).resolves.toBe(false);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/delete",
      "thread/unsubscribe",
    ]);
  });
});

function installedApps(
  appIds: string[],
  state: { enabled?: boolean; callable?: boolean } = {},
): v2.AppsInstalledResponse {
  return {
    apps: appIds.map((id) => ({
      id,
      runtimeName: id,
      enabled: state.enabled ?? true,
      callable: state.callable ?? true,
    })),
  };
}
