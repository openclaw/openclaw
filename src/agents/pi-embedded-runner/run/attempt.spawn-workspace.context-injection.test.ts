import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { filterHeartbeatPairs } from "../../../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../../../auto-reply/heartbeat.js";
import { limitHistoryTurns } from "../history.js";
import { buildEmbeddedMessageActionDiscoveryInput } from "../message-action-discovery-input.js";
import {
  assembleAttemptContextEngine,
  type AttemptContextEngine,
  resolveAttemptBootstrapContext,
} from "./attempt.context-engine-helpers.js";
import { resetEmbeddedAttemptHarness } from "./attempt.spawn-workspace.test-support.js";

async function resolveBootstrapContext(params: {
  contextInjectionMode?: "always" | "continuation-skip";
  bootstrapContextMode?: string;
  bootstrapContextRunKind?: string;
  completed?: boolean;
  resolver?: () => Promise<{
    bootstrapFiles: unknown[];
    contextFiles: unknown[];
    bootstrapSignature?: string;
  }>;
  signatureResolver?: () => Promise<string | undefined>;
}) {
  const hasCompletedBootstrapTurn = vi.fn(async () => params.completed ?? false);
  const resolveBootstrapContextForRun =
    params.resolver ??
    vi.fn(async () => ({
      bootstrapFiles: [],
      contextFiles: [],
    }));
  const resolveBootstrapSignatureForRun = params.signatureResolver ?? vi.fn(async () => undefined);

  const result = await resolveAttemptBootstrapContext({
    contextInjectionMode: params.contextInjectionMode ?? "always",
    bootstrapContextMode: params.bootstrapContextMode ?? "full",
    bootstrapContextRunKind: params.bootstrapContextRunKind ?? "default",
    sessionFile: "/tmp/session.jsonl",
    resolveBootstrapSignatureForRun,
    hasCompletedBootstrapTurn,
    resolveBootstrapContextForRun,
  });

  return {
    result,
    hasCompletedBootstrapTurn,
    resolveBootstrapContextForRun,
    resolveBootstrapSignatureForRun,
  };
}

describe("embedded attempt context injection", () => {
  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  it("skips bootstrap reinjection on safe continuation turns when configured", async () => {
    const { result, hasCompletedBootstrapTurn, resolveBootstrapContextForRun } =
      await resolveBootstrapContext({
        contextInjectionMode: "continuation-skip",
        completed: true,
      });

    expect(result.isContinuationTurn).toBe(true);
    expect(result.bootstrapFiles).toEqual([]);
    expect(result.contextFiles).toEqual([]);
    expect(hasCompletedBootstrapTurn).toHaveBeenCalledWith("/tmp/session.jsonl");
    expect(resolveBootstrapContextForRun).not.toHaveBeenCalled();
  });

  it("still resolves bootstrap context when continuation-skip has no completed assistant turn yet", async () => {
    const resolver = vi.fn(async () => ({
      bootstrapFiles: [{ name: "AGENTS.md" }],
      contextFiles: [{ path: "AGENTS.md" }],
    }));

    const { result } = await resolveBootstrapContext({
      contextInjectionMode: "continuation-skip",
      completed: false,
      resolver,
    });

    expect(result.isContinuationTurn).toBe(false);
    expect(result.bootstrapFiles).toEqual([{ name: "AGENTS.md" }]);
    expect(result.contextFiles).toEqual([{ path: "AGENTS.md" }]);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("forwards senderIsOwner into embedded message-action discovery", async () => {
    const input = buildEmbeddedMessageActionDiscoveryInput({
      cfg: {},
      channel: "matrix",
      currentChannelId: "room",
      currentThreadTs: "thread",
      currentMessageId: 123,
      accountId: "work",
      sessionKey: "agent:main",
      sessionId: "session",
      agentId: "main",
      senderId: "@alice:example.org",
      senderIsOwner: false,
    });

    expect(input).toMatchObject({
      channel: "matrix",
      currentChannelId: "room",
      currentThreadTs: "thread",
      currentMessageId: 123,
      accountId: "work",
      sessionKey: "agent:main",
      sessionId: "session",
      agentId: "main",
      requesterSenderId: "@alice:example.org",
      senderIsOwner: false,
    });
  });

  it("never skips heartbeat bootstrap filtering", async () => {
    const { result, hasCompletedBootstrapTurn, resolveBootstrapContextForRun } =
      await resolveBootstrapContext({
        contextInjectionMode: "continuation-skip",
        bootstrapContextMode: "lightweight",
        bootstrapContextRunKind: "heartbeat",
        completed: true,
      });

    expect(result.isContinuationTurn).toBe(false);
    expect(result.shouldRecordCompletedBootstrapTurn).toBe(false);
    expect(hasCompletedBootstrapTurn).not.toHaveBeenCalled();
    expect(resolveBootstrapContextForRun).toHaveBeenCalledTimes(1);
  });

  it("does not resolve bootstrap signatures when continuation checks cannot apply", async () => {
    const { resolveBootstrapSignatureForRun } = await resolveBootstrapContext({
      contextInjectionMode: "always",
    });

    expect(resolveBootstrapSignatureForRun).not.toHaveBeenCalled();
  });

  it("does not resolve bootstrap signatures when the continuation precheck fails", async () => {
    const { resolveBootstrapSignatureForRun } = await resolveBootstrapContext({
      contextInjectionMode: "continuation-skip",
      completed: false,
    });

    expect(resolveBootstrapSignatureForRun).not.toHaveBeenCalled();
  });

  it("passes the resolved bootstrap signature into continuation checks", async () => {
    const {
      hasCompletedBootstrapTurn,
      resolveBootstrapContextForRun,
      resolveBootstrapSignatureForRun,
    } =
      await resolveBootstrapContext({
        contextInjectionMode: "continuation-skip",
        completed: true,
        signatureResolver: vi.fn(async () => "agents:/tmp/AGENTS.hook.md"),
      });

    expect(resolveBootstrapSignatureForRun).toHaveBeenCalledTimes(1);
    expect(resolveBootstrapContextForRun).not.toHaveBeenCalled();
    expect(hasCompletedBootstrapTurn).toHaveBeenNthCalledWith(1, "/tmp/session.jsonl");
    expect(hasCompletedBootstrapTurn).toHaveBeenNthCalledWith(
      2,
      "/tmp/session.jsonl",
      "agents:/tmp/AGENTS.hook.md",
    );
  });

  it("runs full bootstrap injection after a successful non-heartbeat turn", async () => {
    const resolver = vi.fn(async () => ({
      bootstrapFiles: [{ name: "AGENTS.md", content: "bootstrap context" }],
      contextFiles: [{ path: "AGENTS.md", content: "bootstrap context" }],
    }));

    const { result } = await resolveBootstrapContext({
      bootstrapContextMode: "full",
      bootstrapContextRunKind: "default",
      resolver,
    });

    expect(result.shouldRecordCompletedBootstrapTurn).toBe(true);
    expect(result.bootstrapFiles).toEqual([{ name: "AGENTS.md", content: "bootstrap context" }]);
  });

  it("does not record full bootstrap completion for heartbeat runs", async () => {
    const { result } = await resolveBootstrapContext({
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "heartbeat",
    });

    expect(result.shouldRecordCompletedBootstrapTurn).toBe(false);
  });

  it("filters no-op heartbeat pairs before history limiting and context-engine assembly", async () => {
    const assemble = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({
      messages,
      estimatedTokens: 1,
    }));
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "real question", timestamp: 1 } as AgentMessage,
      { role: "assistant", content: "real answer", timestamp: 2 } as unknown as AgentMessage,
      { role: "user", content: HEARTBEAT_PROMPT, timestamp: 3 } as AgentMessage,
      { role: "assistant", content: "HEARTBEAT_OK", timestamp: 4 } as unknown as AgentMessage,
    ];

    const heartbeatFiltered = filterHeartbeatPairs(sessionMessages, undefined, HEARTBEAT_PROMPT);
    const limited = limitHistoryTurns(heartbeatFiltered, 1);
    await assembleAttemptContextEngine({
      contextEngine: {
        info: { id: "test", name: "Test", version: "0.0.1" },
        ingest: async () => ({ ingested: true }),
        compact: async () => ({ ok: false, compacted: false, reason: "unused" }),
        assemble,
      } satisfies AttemptContextEngine,
      sessionId: "session",
      sessionKey: "agent:main:discord:dm:test-user",
      messages: limited,
      modelId: "gpt-test",
    });

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: "user", content: "real question" }),
          expect.objectContaining({ role: "assistant", content: "real answer" }),
        ],
      }),
    );
  });
});
