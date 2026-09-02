import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "./protocol.js";
import {
  createCodexDynamicToolExecutionRegistry,
  fingerprintCodexDynamicToolResponse,
} from "./run-attempt-tools.js";
import { CodexTranscriptCheckpoint } from "./transcript-checkpoint.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const providerCommit = vi.hoisted(() => ({
  commit: vi.fn(),
  enabled: true,
}));
const mirrorRuntime = vi.hoisted(() => ({
  mirror: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-session-transcript-runtime", () => ({
  commitProviderSessionTranscriptPrefix: providerCommit.commit,
  hasProviderSessionTranscriptCapability: () => providerCommit.enabled,
}));
vi.mock("./transcript-mirror.js", () => ({
  codexTranscriptMirrorRuntime: mirrorRuntime,
}));

function call(arguments_: JsonObject, namespace: string | null = null) {
  return {
    namespace,
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    tool: "exec",
    arguments: arguments_,
  };
}

describe("Codex provider transcript durability", () => {
  beforeEach(() => {
    providerCommit.commit.mockReset();
    providerCommit.enabled = true;
    mirrorRuntime.mirror.mockReset();
  });

  it("shares an exact request execution and rejects changed payload reuse", async () => {
    const registry = createCodexDynamicToolExecutionRegistry();
    const start = vi.fn(async () => ({ contentItems: [], success: true }));
    const claimed = registry.claim(call({ command: "same" }), start).execution;

    expect(registry.get(call({ command: "same" }))).toBe(claimed);
    await expect(claimed).resolves.toMatchObject({ success: true });
    expect(start).toHaveBeenCalledOnce();
    expect(() => registry.get(call({ command: "changed" }))).toThrow(
      "reused with a changed request",
    );
  });

  it("rejects reuse when only the namespace changes", async () => {
    const registry = createCodexDynamicToolExecutionRegistry();
    const start = vi.fn(async () => ({ contentItems: [], success: true }));
    const claimed = registry.claim(call({ command: "same" }, "openclaw"), start).execution;

    await expect(claimed).resolves.toMatchObject({ success: true });
    expect(() => registry.get(call({ command: "same" }, "other"))).toThrow(
      "reused with a changed request",
    );
    expect(start).toHaveBeenCalledOnce();
  });

  it("retains a rejected execution and persistence promise", async () => {
    const registry = createCodexDynamicToolExecutionRegistry();
    const failure = Promise.reject(new Error("transcript persistence failed"));
    void failure.catch(() => undefined);

    expect(registry.claim(call({ command: "same" }), () => failure).execution).toBe(failure);
    expect(registry.get(call({ command: "same" }))).toBe(failure);
    await expect(failure).rejects.toThrow("transcript persistence failed");
  });

  it("commits only the sanitized projection and full source fingerprint", async () => {
    providerCommit.commit.mockResolvedValueOnce({
      anchors: [],
      kind: "committed",
      messages: [],
    });
    const checkpoint = new CodexTranscriptCheckpoint(
      {
        hostCapabilities: { assertActive: () => undefined },
        runId: "run-1",
        sessionId: "session-1",
        sessionTarget: {
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          storePath: "/tmp/sessions.json",
        },
      } as never,
      "thread-1",
      "turn-1",
    );
    const message = attachCodexMirrorIdentity(
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        content: [{ type: "text", text: "sanitized" }],
        isError: false,
        timestamp: 1,
      } as AgentMessage,
      "turn-1:tool:call-1:result",
    );
    const sourceFingerprint = fingerprintCodexDynamicToolResponse(
      call({ command: "raw-provider-secret" }),
      {
        contentItems: [{ type: "inputText", text: "raw-provider-secret" }],
        success: true,
      },
    );
    checkpoint.enqueue({
      read: () => message,
      sourceFingerprint,
    });

    await checkpoint.flush();

    expect(providerCommit.commit).toHaveBeenCalledWith({
      hostCapabilities: expect.any(Object),
      entries: [
        {
          eventId: "codex-app-server:thread-1:turn-1:tool:call-1:result",
          identity: "codex-app-server:thread-1:turn-1:tool:call-1:result",
          message: expect.objectContaining({
            content: [{ type: "text", text: "sanitized" }],
          }),
          sourceFingerprint,
        },
      ],
    });
    expect(sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(providerCommit.commit.mock.calls)).not.toContain("raw-provider-secret");
  });

  it("fails closed when a provider checkpoint has no host authority", async () => {
    providerCommit.enabled = false;
    const checkpoint = new CodexTranscriptCheckpoint(
      {
        hostCapabilities: { assertActive: () => undefined },
        runId: "run-1",
        sessionId: "session-1",
        sessionTarget: {
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          storePath: "/tmp/sessions.json",
        },
      } as never,
      "thread-1",
      "turn-1",
    );
    checkpoint.enqueue({
      read: () =>
        attachCodexMirrorIdentity(
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "exec",
            content: [{ type: "text", text: "sanitized" }],
            isError: false,
          } as AgentMessage,
          "turn-1:tool:call-1:result",
        ),
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
    });

    await expect(checkpoint.flush()).rejects.toThrow(
      "Codex provider transcript commit requires host capability",
    );
    expect(providerCommit.commit).not.toHaveBeenCalled();
  });

  it("keeps a predecessor mirror failure sticky before a provider result", async () => {
    const failure = new Error("preceding transcript persistence failed");
    mirrorRuntime.mirror.mockRejectedValueOnce(failure);
    const checkpoint = new CodexTranscriptCheckpoint(
      {
        hostCapabilities: { assertActive: () => undefined },
        runId: "run-1",
        sessionId: "session-1",
        sessionTarget: {
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          storePath: "/tmp/sessions.json",
        },
      } as never,
      "thread-1",
      "turn-1",
    );
    checkpoint.enqueue({
      read: () =>
        attachCodexMirrorIdentity(
          {
            role: "assistant",
            content: [{ type: "text", text: "preceding commentary" }],
            timestamp: 1,
          } as AgentMessage,
          "turn-1:commentary:item-1",
        ),
    });
    checkpoint.enqueue({
      read: () =>
        attachCodexMirrorIdentity(
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "exec",
            content: [{ type: "text", text: "durable result" }],
            isError: false,
            timestamp: 2,
          } as AgentMessage,
          "turn-1:tool:call-1:result",
        ),
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
    });
    const sendProviderResponse = vi.fn();
    const registry = createCodexDynamicToolExecutionRegistry();
    const execution = registry.claim(call({ command: "same" }), async () => {
      await checkpoint.flush();
      sendProviderResponse();
      return { contentItems: [], success: true };
    }).execution;

    await expect(execution).rejects.toBe(failure);
    await expect(checkpoint.flush()).rejects.toBe(failure);
    expect(sendProviderResponse).not.toHaveBeenCalled();
    expect(mirrorRuntime.mirror).toHaveBeenCalledOnce();
    expect(providerCommit.commit).not.toHaveBeenCalled();
    expect(registry.get(call({ command: "same" }))).toBe(execution);
  });
});
