import { expect, it, vi } from "vitest";
import { releaseCodexAttemptThreadSubscription } from "./attempt-client-cleanup.js";
import { createCodexRecoveryClientAcquirer } from "./attempt-recovery-client.js";
import { withCodexStartupTimeout } from "./attempt-timeouts.js";
import {
  claimCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
} from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import type { CodexBindingAuthority } from "./session-binding.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import { releaseCodexBoundLiveThread } from "./thread-lifecycle-warm.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

function createRecoveryHarness(rejectUnsubscribe = false) {
  let rejects = rejectUnsubscribe;
  const harness = createClientHarness({
    onWrite: (line, send) => {
      const request = JSON.parse(line) as {
        id?: number;
        method: string;
        params?: { threadId?: string };
      };
      if (request.id === undefined) {
        return;
      }
      if (
        rejects &&
        request.method === "thread/unsubscribe" &&
        request.params?.threadId === "failed"
      ) {
        send({ id: request.id, error: { code: -32603, message: "fixture unsubscribe failed" } });
        return;
      }
      send({
        id: request.id,
        result:
          request.method === "initialize"
            ? { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` }
            : request.method === "config/read"
              ? { config: {}, origins: {}, layers: [] }
              : {},
      });
    },
  });
  return Object.assign(harness, {
    recoverUnsubscribe: () => {
      rejects = false;
    },
  });
}

function authority(assertCurrent = () => {}): CodexBindingAuthority {
  return {
    lineage: [],
    assertCurrent,
    assertLegacyCurrent: assertCurrent,
    prepareMutation: async () => ({ assertCurrent }),
    withCurrent: async (write) => {
      assertCurrent();
      return write();
    },
  };
}

/** Uses the existing shared-client suite's auth mocks and pool teardown. */
export function registerSharedClientRecoveryCleanupTests() {
  it.each(["abort", "superseded"] as const)(
    "rechecks recovery acquisition after artifact verification (%s)",
    async (mode) => {
      const harness = createRecoveryHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const options = { timeoutMs: 1_000 };
      const peer = await getLeasedSharedCodexAppServerClient(options);
      const controller = new AbortController();
      let current = true;
      const initializeRuntime = vi.fn();
      const acquire = createCodexRecoveryClientAcquirer({
        attemptClientFactory: getLeasedSharedCodexAppServerClient,
        clientOptions: options,
        assertCurrent: () => {
          if (!current) {
            throw new Error("fixture superseded");
          }
        },
        verifyArtifact: async () => {
          await Promise.resolve();
          if (mode === "abort") {
            controller.abort(new Error("fixture cancelled"));
          } else {
            current = false;
          }
        },
        initializeRuntime,
      });
      try {
        await expect(
          acquire(controller.signal).then((lease) => {
            lease.release();
            return lease;
          }),
        ).rejects.toThrow(/fixture (cancelled|superseded)/);
        expect(initializeRuntime).not.toHaveBeenCalled();
        expect(peer.getCloseError()).toBeUndefined();
      } finally {
        releaseLeasedSharedCodexAppServerClient(peer);
      }
    },
  );

  it("retires only the failed recovery subscription client while its sibling continues", async () => {
    const old = createRecoveryHarness(true);
    const next = createRecoveryHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(old.client)
      .mockResolvedValueOnce(next.client);
    const options = { timeoutMs: 1_000 };
    const client = await getLeasedSharedCodexAppServerClient(options);
    const peer = await getLeasedSharedCodexAppServerClient(options);
    ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/recovery-cleanup" });
    const ownership = await claimCodexAppServerLiveThread(client, "failed");
    const peerOwnership = await claimCodexAppServerLiveThread(peer, "sibling");
    expect(ownership).toBeDefined();
    expect(peerOwnership).toBeDefined();
    const route = getCodexAppServerTurnRouter(client).reserveThread({ threadId: "failed" });
    const cleanupAuthority = authority();
    let replacement: CodexAppServerClient | undefined;
    try {
      expect(
        await releaseCodexAttemptThreadSubscription({
          client,
          thread: {
            threadId: "failed",
            cwd: "/tmp",
            lifecycle: { action: "resumed" },
            liveThreadOwnership: ownership,
          },
          recoveryRoute: route,
          readCurrentRoute: () => route,
          cleanupAuthority,
          nativeSettlementExpired: false,
          withCurrent: cleanupAuthority.withCurrent,
        }),
      ).toBe(false);
      expect(hasCodexAppServerLiveThread(client, "failed")).toBe(true);
      expect(isCodexAppServerLiveThreadClaimed(client, "failed")).toBe(false);
      expect(() => peerOwnership?.assertCurrent()).not.toThrow();
      expect(peer.getCloseError()).toBeUndefined();
      await expect(peer.request("config/read", {})).resolves.toMatchObject({ config: {} });
      replacement = await getLeasedSharedCodexAppServerClient(options);
      expect(replacement).toBe(next.client);
      await expect(replacement.request("config/read", {})).resolves.toMatchObject({ config: {} });
      releaseLeasedSharedCodexAppServerClient(client);
      old.recoverUnsubscribe();
      const handoff = releaseCodexBoundLiveThread({
        client: replacement,
        clientId: replacement.getInstanceId(),
        ownerClientId: client.getInstanceId(),
        threadId: "failed",
        lifecycleTiming: createCodexThreadLifecycleTimingTracker(),
      });
      await expect(
        withCodexStartupTimeout({
          timeoutMs: 30,
          signal: new AbortController().signal,
          operation: () => handoff,
        }),
      ).rejects.toThrow("startup timed out");
      expect(hasCodexAppServerLiveThread(client, "failed")).toBe(false);
      expect(() => peerOwnership?.assertCurrent()).not.toThrow();
      expect(peer.getCloseError()).toBeUndefined();
      await expect(replacement.request("config/read", {})).resolves.toMatchObject({ config: {} });
      await peerOwnership?.release("sibling");
      releaseLeasedSharedCodexAppServerClient(peer);
      await expect(handoff).resolves.toBe(true);
      expect(client.getCloseError()).toBeDefined();
      await expect(
        releaseCodexBoundLiveThread({
          client: replacement,
          clientId: replacement.getInstanceId(),
          ownerClientId: client.getInstanceId(),
          threadId: "failed",
          lifecycleTiming: createCodexThreadLifecycleTimingTracker(),
        }),
      ).resolves.toBe(false);
      ensureCodexAppServerClientRuntime(replacement, { agentDir: "/tmp/recovery-cleanup" });
      const nextOwnership = await claimCodexAppServerLiveThread(replacement, "failed");
      expect(nextOwnership).toBeDefined();
      await nextOwnership?.release("failed");
    } finally {
      route.release();
      releaseLeasedSharedCodexAppServerClient(client);
      releaseLeasedSharedCodexAppServerClient(peer);
      if (replacement) {
        releaseLeasedSharedCodexAppServerClient(replacement);
      }
      next.client.close();
    }
  });

  it.each(["route", "authority"] as const)(
    "rejects obsolete recovery cleanup without forgetting or retiring its successor (%s)",
    async (mode) => {
      const harness = createRecoveryHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const options = { timeoutMs: 1_000 };
      const client = await getLeasedSharedCodexAppServerClient(options);
      ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/recovery-cleanup" });
      const ownership = await claimCodexAppServerLiveThread(client, "failed");
      expect(ownership).toBeDefined();
      let currentOwnership = ownership;
      if (mode === "route") {
        ownership?.forget();
        currentOwnership = await claimCodexAppServerLiveThread(client, "failed");
        expect(currentOwnership).toBeDefined();
      }
      const router = getCodexAppServerTurnRouter(client);
      const route = router.reserveThread({ threadId: "failed" });
      route.release();
      const successor = router.reserveThread({ threadId: "failed" });
      const cleanupAuthority = authority(() => {
        if (mode === "authority") {
          throw new Error("fixture obsolete authority");
        }
      });
      try {
        await expect(
          releaseCodexAttemptThreadSubscription({
            client,
            thread: {
              threadId: "failed",
              cwd: "/tmp",
              lifecycle: { action: "resumed" },
              liveThreadOwnership: ownership,
            },
            recoveryRoute: route,
            readCurrentRoute: () => (mode === "route" ? successor : route),
            cleanupAuthority,
            nativeSettlementExpired: false,
            withCurrent: cleanupAuthority.withCurrent,
          }),
        ).rejects.toThrow(/ownership changed|obsolete authority/);
        expect(() => currentOwnership?.assertCurrent()).not.toThrow();
        expect(
          harness.writes.some((line) => JSON.parse(line).method === "thread/unsubscribe"),
        ).toBe(false);
        await expect(getLeasedSharedCodexAppServerClient(options)).resolves.toBe(client);
        releaseLeasedSharedCodexAppServerClient(client);
      } finally {
        successor.release();
        releaseLeasedSharedCodexAppServerClient(client);
      }
    },
  );
}
