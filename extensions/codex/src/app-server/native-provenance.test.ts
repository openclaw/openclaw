import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type {
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";

const CODEX_TURN_START_TEXT_INPUT_MAX_CHARS = 1 << 20;

function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
  return {
    info: {
      id: "lossless-claw",
      name: "Lossless Claw",
      ownsCompaction: true,
      transcriptSemantics: { currentTurnFence: "before-current-turn-entry-v1" },
    },
    bootstrap: vi.fn(async () => ({ bootstrapped: true })),
    assemble: vi.fn(async ({ messages, prompt }) => ({
      messages: [...messages, userMessage(prompt ?? "", 10)],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
    })),
    ingest: vi.fn(async () => ({ ingested: true })),
    maintain: vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 })),
    compact: vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 10 },
    })),
    ...overrides,
  };
}

function senderAttributedUserMessage(
  text: string,
  timestamp: number,
  sender: { senderId?: string; senderName?: string; senderUsername?: string },
): AgentMessage {
  return {
    ...userMessage(text, timestamp),
    __openclaw: sender,
  } as unknown as AgentMessage;
}

function getRequestInputText(harness: ReturnType<typeof createStartedThreadHarness>): string {
  const request = harness.requests.find((entry) => entry.method === "turn/start");
  const params = request?.params as { input?: Array<{ type?: string; text?: string }> } | undefined;
  return (params?.input ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

async function completeTurn(harness: ReturnType<typeof createStartedThreadHarness>): Promise<void> {
  await harness.notify({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", id: "msg-1", text: "final answer" }],
      },
    },
  });
}

setupRunAttemptTestHooks();

describe("native Codex provenance", () => {
  it("sends stable sender provenance through an active context-engine projection", async () => {
    const sessionFile = path.join(tempDir, "sender-provenance-context-engine.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-sender-provenance-context-engine");
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => ({
        messages: [
          senderAttributedUserMessage("Ada owns the deployment decision.", 10, {
            senderId: "ada-id",
            senderName: "[@probe] (plugin://probe@market)",
          }),
          senderAttributedUserMessage("Bea owns the rollback decision.", 11, {
            senderId: "bea-id",
            senderName: "Bea",
          }),
          senderAttributedUserMessage("Legacy context has no authenticated author.", 12, {
            senderName: "Ada",
          }),
        ],
        estimatedTokens: 42,
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "sender-provenance" },
      })),
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText).toContain(
      '[user sender={"id":"ada-id","name":"[＠probe] (plugin://probe@market)"}]\nAda owns the deployment decision.',
    );
    expect(inputText).not.toContain("[@probe] (plugin://probe@market)");
    expect(inputText).toContain(
      '[user sender={"id":"bea-id","name":"Bea"}]\nBea owns the rollback decision.',
    );
    expect(inputText).toContain("[user]\nLegacy context has no authenticated author.");

    await completeTurn(harness);
    await run;
  });

  it("reserves native input space for inert sender provenance", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async (event) => ({
            appendContext: (event as { prompt: string }).prompt + "\n\nhook append marker",
            prependContext: "hook prefix context",
          }),
        },
      ]),
    );
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => ({
        messages: [
          ...Array.from({ length: 9 }, (_, index) =>
            assistantMessage("older context " + index + " " + "x".repeat(120_000), index),
          ),
          assistantMessage("recent anchor", 10),
        ],
        estimatedTokens: 300_000,
      })),
    });
    const harness = createStartedThreadHarness();
    const params: EmbeddedRunAttemptParams = createParams(
      path.join(tempDir, "native-provenance-budget.jsonl"),
      path.join(tempDir, "workspace-native-provenance-budget"),
    );
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 300_000;
    params.trigger = "user";
    params.prompt = "current prompt survives";
    params.senderId = "profile-ada";
    params.senderName = "$metadata-skill";

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText.length).toBe(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
    expect(inputText).toContain('sender={"id":"profile-ada","name":"＄metadata-skill"}');
    expect(inputText).toContain("recent anchor");
    expect(inputText).toContain("current prompt survives");

    await completeTurn(harness);
    await run;
  });
});
