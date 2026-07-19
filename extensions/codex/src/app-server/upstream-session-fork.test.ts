import { describe, expect, it, vi } from "vitest";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";

const boundary = {
  beforeTurnId: "turn-2",
  targetTurnId: "turn-2",
  retainedMarker: { turnId: "turn-1", userMessageCount: 1 },
} as const;

vi.mock("./upstream-fork-boundary.js", () => ({
  resolveCodexUpstreamForkBoundary: vi.fn(async () => ({ ok: true, boundary })),
  listCodexUpstreamTurns: vi.fn(async () => [{ id: "turn-2", status: "completed", items: [] }]),
  precheckCodexUpstreamForkBoundary: vi.fn(() => ({ ok: true, boundary })),
}));

import { forkCodexUpstreamSession } from "./upstream-session-fork.js";

describe("forkCodexUpstreamSession", () => {
  it("forks before the mapped turn and attaches the returned thread", async () => {
    const forkThread = vi.fn(async () => ({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      cwd: "/tmp",
      model: "gpt-5.4",
      modelProvider: "openai",
      sandbox: { type: "dangerFullAccess" },
      thread: {
        id: "thread-forked",
        sessionId: "session-forked",
        cliVersion: "0.143.0",
        createdAt: 1715299200,
        updatedAt: 1715299200,
        cwd: "/tmp",
        ephemeral: false,
        modelProvider: "openai",
        preview: "forked thread",
        source: "appServer",
        status: { type: "notLoaded" },
        turns: [],
      },
    }));
    const archiveThread = vi.fn(async () => undefined);
    const control = {
      archiveThread,
      connectionFingerprint: "fingerprint",
      forkThread,
    } as unknown as CodexSessionCatalogControl;
    control.withPinnedConnection = async (run) => await run(control);
    const mutate = vi.fn(async () => true);

    const result = await forkCodexUpstreamSession(
      {
        source: {
          agentId: "main",
          sessionId: "session-source",
          sessionKey: "agent:main:source",
          storePath: "/tmp/sessions.db",
          entryId: "entry-2",
        },
        upstream: {
          kind: "codex-app-server",
          threadId: "thread-source",
          ref: { connectionFingerprint: "fingerprint", threadId: "thread-source" },
        },
      },
      {
        bindingStore: { mutate } as unknown as CodexAppServerBindingStore,
        control,
      },
    );

    expect(forkThread).toHaveBeenCalledWith({
      threadId: "thread-source",
      beforeTurnId: "turn-2",
      excludeTurns: true,
    });
    expect(result).toMatchObject({
      status: "forked",
      upstream: {
        marker: { turnId: "turn-1", userMessageCount: 1 },
        threadId: "thread-forked",
      },
    });
    if (result.status !== "forked") {
      throw new Error("expected the Codex fork to succeed");
    }
    await result.attach({
      agentId: "main",
      sessionId: "session-local-fork",
      sessionKey: "agent:main:fork",
    });
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-local-fork" }),
      expect.objectContaining({
        kind: "set",
        binding: expect.objectContaining({ threadId: "thread-forked" }),
      }),
    );
    await result.archive();
    expect(mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "session-local-fork" }),
      { kind: "clear", threadId: "thread-forked" },
    );
    expect(archiveThread).toHaveBeenCalledWith("thread-forked");
  });

  it("archives a recoverable orphan id when the fork response is invalid", async () => {
    const archiveThread = vi.fn(async () => undefined);
    const control = {
      archiveThread,
      connectionFingerprint: "fingerprint",
      forkThread: vi.fn(async () => ({ thread: { id: "thread-orphan" } })),
    } as unknown as CodexSessionCatalogControl;
    control.withPinnedConnection = async (run) => await run(control);

    const result = await forkCodexUpstreamSession(
      {
        source: {
          agentId: "main",
          sessionId: "session-source",
          sessionKey: "agent:main:source",
          storePath: "/tmp/sessions.db",
          entryId: "entry-2",
        },
        upstream: {
          kind: "codex-app-server",
          threadId: "thread-source",
          ref: { connectionFingerprint: "fingerprint", threadId: "thread-source" },
        },
      },
      {
        bindingStore: {} as CodexAppServerBindingStore,
        control,
      },
    );

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(archiveThread).toHaveBeenCalledWith("thread-orphan");
  });
});
