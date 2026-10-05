import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it, vi } from "vitest";
import {
  compactCodexSessionWithTestHost as maybeCompactCodexAppServerSessionImpl,
  createFakeCodexCompactionClient,
  flushAsyncTasks,
} from "./compact.test-support.js";
import { resolveCodexSessionBinding } from "./session-binding.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { withCodexAppServerThreadMutation } from "./thread-ownership.js";

export function registerCompactionStartupAuthorityTests(params: {
  getTempDir: () => string;
  createFakeCodexClient: (
    options?: Parameters<typeof createFakeCodexCompactionClient>[1],
  ) => ReturnType<typeof createFakeCodexCompactionClient>;
}) {
  const { getTempDir, createFakeCodexClient } = params;
  it("rejects a host-only rotation after recovering the predecessor during compaction startup", async () => {
    const current = {
      kind: "session" as const,
      agentId: "main",
      sessionKey: "agent:main:recovered-compaction",
      sessionId: "after-compaction",
    };
    const previous = { ...current, sessionId: "before-compaction" };
    const scope = {
      agentId: current.agentId,
      sessionKey: current.sessionKey,
      storePath: path.join(getTempDir(), "admitted", "sessions.json"),
    };
    await upsertSessionEntry({ ...scope, entry: { sessionId: previous.sessionId, updatedAt: 1 } });
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: current.sessionId }) });
    const bindingStore = createCodexTestBindingStore();
    const binding = { threadId: "thread-1", cwd: getTempDir() };
    await bindingStore.mutate(previous, { kind: "set", binding });
    const fake = createFakeCodexClient({ retainedThreadId: null });

    const result = await maybeCompactCodexAppServerSessionImpl(
      {
        sessionId: current.sessionId,
        sessionKey: current.sessionKey,
        agentId: current.agentId,
        sessionTarget: { ...scope, sessionId: current.sessionId },
        sessionFile: path.join(getTempDir(), "recovered.jsonl"),
        workspaceDir: getTempDir(),
        trigger: "manual",
      },
      {
        bindingStore,
        clientFactory: async () => {
          expect(bindingStore.read(current)).toEqual(binding);
          await patchSessionEntry({ ...scope, update: () => ({ sessionId: "next-compaction" }) });
          return fake.client;
        },
      },
    );

    expect(
      fake.request.mock.calls.some(([method]) =>
        ["thread/resume", "thread/compact/start"].includes(method),
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: expect.stringContaining("Codex session generation is no longer current"),
    });
    expect(bindingStore.read(current)).toEqual(binding);
  });

  it("rejects a queued compaction after admitted authority rotates before client acquisition", async () => {
    const current = {
      kind: "session" as const,
      agentId: "main",
      sessionKey: "agent:main:queued-authority",
      sessionId: "session-current",
    };
    const successor = { ...current, sessionId: "session-successor" };
    const scope = {
      agentId: current.agentId,
      sessionKey: current.sessionKey,
      storePath: path.join(getTempDir(), "admitted", "sessions.json"),
    };
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: current.sessionId, updatedAt: 1 },
    });
    const bindingStore = createCodexTestBindingStore();
    const binding = { threadId: "thread-queued", cwd: getTempDir() };
    await bindingStore.mutate(current, { kind: "set", binding });
    const fake = createFakeCodexClient();
    const clientFactory = vi.fn(async () => fake.client);
    const queueEntered = createDeferred<void>();
    const releaseQueue = createDeferred<void>();
    const held = withCodexAppServerThreadMutation(binding.threadId, async () => {
      queueEntered.resolve();
      await releaseQueue.promise;
    });
    await queueEntered.promise;

    const pending = maybeCompactCodexAppServerSessionImpl(
      {
        sessionId: current.sessionId,
        sessionKey: current.sessionKey,
        agentId: current.agentId,
        sessionTarget: { ...scope, sessionId: current.sessionId },
        sessionFile: path.join(getTempDir(), "queued-authority.jsonl"),
        workspaceDir: getTempDir(),
        trigger: "manual",
      },
      { bindingStore, clientFactory },
    );
    try {
      await flushAsyncTasks();
      expect(clientFactory).not.toHaveBeenCalled();

      await patchSessionEntry({ ...scope, update: () => ({ sessionId: successor.sessionId }) });
    } finally {
      releaseQueue.resolve();
      await held;
    }

    await expect(pending).rejects.toThrow("Codex session generation is no longer current");
    expect(clientFactory).not.toHaveBeenCalled();
    expect(fake.request).not.toHaveBeenCalled();
    expect(bindingStore.read(current)).toEqual(binding);

    const adopted = await resolveCodexSessionBinding({
      bindingStore,
      identity: successor,
      storePath: scope.storePath,
    });
    expect(adopted.binding).toEqual(binding);
    expect(bindingStore.read(successor)).toEqual(binding);
  });
}
