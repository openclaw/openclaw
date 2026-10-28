import { expect, it, vi } from "vitest";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import {
  isUserMessage,
  prepareModelPromptProjection,
} from "../../sessions/user-turn-transcript.message.js";
import { setCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import safeguard from "../agent-hooks/compaction-safeguard.js";
import { agentSessionAutomaticCompaction } from "./agent-session-compaction.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { preflightManualSessionCompaction } from "./manual-compaction-preflight.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

it.each(["core", "safeguard", "provider", "deterministic"] as const)(
  "%s compaction expands only summary execution input, not canonical excerpts",
  async (mode) => {
    const sessionManager = SessionManager.inMemory();
    const caption = "Analyze the attachment.";
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    const canonical = {
      role: "user" as const,
      content:
        mode === "provider"
          ? [
              { type: "text" as const, text: caption },
              image,
              { type: "text" as const, text: "Keep the attached diagram." },
            ]
          : caption,
      timestamp: 1,
    };
    const projected = prepareModelPromptProjection(
      canonical,
      "PRIVATE_PROMPT_Q7\nDOCUMENT_FACT_Q7",
    );
    if (!projected) {
      throw new Error("Expected a new projection");
    }
    const userId = await sessionManager.appendMessageAsync(projected);
    if (!userId) {
      throw new Error("Expected the projected user to be persisted");
    }
    await sessionManager.appendMessageAsync(createAssistant(testModel, "Analysis done."));
    if (mode !== "deterministic") {
      await sessionManager.appendMessageAsync({ role: "user", content: "Continue.", timestamp: 3 });
    }
    const inputs: string[] = [];
    const providerInputs: unknown[][] = [];
    streamMocks.streamSimple.mockImplementation((model, context) => {
      inputs.push(JSON.stringify(context.messages));
      return createAssistantResultStream(createAssistant(model, "A neutral generated summary."));
    });
    const registration = {
      provider: {
        id: "projection-summary",
        label: "Projection summary fixture",
        summarize: async ({ messages }: { messages: unknown[] }) => {
          providerInputs.push(messages);
          return "A neutral generated summary.";
        },
      },
    };
    const registry = requireActivePluginRegistry();
    registry.compactionProviders.push(registration);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No live network"));
    setCompactionSafeguardRuntime(sessionManager, {
      model: testModel,
      // Preserve the default three recent turns and disable quality repair. A
      // canonical-excerpts-only shortcut must not discard projected documents.
      qualityGuardEnabled: false,
      ...(mode === "provider" ? { provider: registration.provider.id } : {}),
    });
    try {
      const { session } = await createTestSession({
        sessionManager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 },
          retry: { enabled: false },
        }),
        resourceLoader: await createResourceLoader(
          mode === "safeguard" || mode === "provider" ? safeguard : undefined,
        ),
      });
      const summary =
        mode === "deterministic"
          ? await session[agentSessionAutomaticCompaction](undefined, "unresolved", "deterministic")
          : { status: "completed" as const, result: await session.compact() };
      expect(summary.status).toBe("completed");
      if (summary.status !== "completed") {
        throw new Error(summary.reason);
      }
      if (mode === "deterministic") {
        expect(inputs).toEqual([]);
        expect(summary.result.summary).toContain(caption);
      } else if (mode === "provider") {
        expect(inputs).toEqual([]);
        expect(providerInputs).toHaveLength(1);
        const user = providerInputs[0]?.find(isUserMessage);
        expect(user?.content).toEqual([
          { type: "text", text: "PRIVATE_PROMPT_Q7\nDOCUMENT_FACT_Q7" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "text", text: "Keep the attached diagram." },
        ]);
        expect(user).not.toHaveProperty("__openclaw.modelPromptProjection");
      } else {
        expect(inputs).toHaveLength(1);
        expect(inputs[0]).toContain("DOCUMENT_FACT_Q7");
        expect(inputs[0]).toContain("PRIVATE_PROMPT_Q7");
      }
      expect(summary.result.summary).not.toContain("PRIVATE_PROMPT_Q7");
      expect(summary.result.summary).not.toContain("DOCUMENT_FACT_Q7");
      expect(sessionManager.getEntry(userId)).toMatchObject({ message: projected });
      expect(network).not.toHaveBeenCalled();
    } finally {
      registry.compactionProviders.splice(registry.compactionProviders.indexOf(registration), 1);
      setCompactionSafeguardRuntime(sessionManager, null);
      network.mockRestore();
    }
  },
);

it("sizes the manual retained tail from frozen prompt text without changing preparation text", async () => {
  const manager = SessionManager.inMemory();
  await manager.appendMessageAsync({ role: "user", content: "Earlier request.", timestamp: 1 });
  await manager.appendMessageAsync(createAssistant(testModel, "Earlier answer. ".repeat(500)));
  const canonical = { role: "user" as const, content: "Analyze the attachment.", timestamp: 3 };
  const projected = prepareModelPromptProjection(canonical, "Document material. ".repeat(600));
  if (!projected) {
    throw new Error("Expected a new projection");
  }
  const userId = await manager.appendMessageAsync(projected);
  if (!userId) {
    throw new Error("Expected the projected user to be persisted");
  }
  await manager.appendMessageAsync(createAssistant(testModel, "Done."));
  const plan = preflightManualSessionCompaction(manager.getBranch(), {
    enabled: true,
    keepRecentTokens: 1000,
    reserveTokens: 1024,
  });
  expect(plan.compactable).toBe(true);
  if (!plan.compactable) {
    throw new Error(plan.reason);
  }
  expect(plan.preparation.firstKeptEntryId).toBe(userId);
  expect(plan.preparation.messagesToSummarize.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);
  expect(manager.getEntry(userId)).toMatchObject({ message: projected });
});
