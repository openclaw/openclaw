import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "../sessions/agent-session-loop-resource-loader.test-support.js";
import { generateSummary as generateRealSummary } from "../sessions/compaction/compaction.js";
import { createEventBus } from "../sessions/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../sessions/extensions/loader.js";
import { SessionManager } from "../sessions/session-manager.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import {
  hookRunner,
  limitHistoryTurnsMock,
  resolveEffectiveCompactionModeMock,
} from "./compact.hooks.harness.js";

type Compact = typeof import("./compact.js").compactEmbeddedAgentSessionDirect;

export function registerCompactionSafeguardTests({
  compactEmbeddedAgentSessionDirect,
  wrappedCompactionArgs,
  getWorkspaceDir,
}: {
  compactEmbeddedAgentSessionDirect: Compact;
  wrappedCompactionArgs: (overrides?: Record<string, unknown>) => Parameters<Compact>[0];
  getWorkspaceDir: () => string;
}) {
  describe("safeguard failure provenance", () => {
    registerAgentSessionLoopTestLifecycle();
    const originalHistoryLimit = expectDefined(
      limitHistoryTurnsMock.getMockImplementation(),
      "history-limit fixture implementation",
    );

    let safeguard: typeof import("../agent-hooks/compaction-safeguard.js").default;
    let setSafeguardRuntime: typeof import("../agent-hooks/compaction-safeguard-runtime.js").setCompactionSafeguardRuntime;
    let summaryBridge: typeof import("../sessions/index.js").generateSummary;

    beforeAll(async () => {
      // The outer harness resets modules and mocks the session SDK. Retain the real
      // disposable session fixture above, but share the safeguard registry with the runner.
      safeguard = (await import("../agent-hooks/compaction-safeguard.js")).default;
      setSafeguardRuntime = (await import("../agent-hooks/compaction-safeguard-runtime.js"))
        .setCompactionSafeguardRuntime;
      summaryBridge = (await import("../sessions/index.js")).generateSummary;
    });

    afterEach(() => {
      vi.mocked(summaryBridge).mockReset().mockResolvedValue("summary");
      limitHistoryTurnsMock.mockImplementation(originalHistoryLimit);
    });

    it("keeps workspace rules in explicit compaction when the Gateway cwd differs", async () => {
      const { createAgentSession } = await import("../sessions/sdk.js");
      const { guardSessionManager } = await import("../session-tool-result-guard-wrapper.js");
      const { buildEmbeddedExtensionFactories } = await import("./extensions.js");
      const actualExtensions =
        await vi.importActual<typeof import("./extensions.js")>("./extensions.js");
      await writeFile(
        join(getWorkspaceDir(), "AGENTS.md"),
        "## Compaction fixture\nWORKSPACE_RULE_MARKER\n",
      );
      const sessionManager = SessionManager.inMemory(getWorkspaceDir());
      for (const content of [
        "Start the task.",
        "Preserve workspace rules.",
        "Continue the task.",
      ]) {
        await sessionManager.appendMessageAsync({ role: "user", content, timestamp: 1 });
      }
      const extension = await loadExtensionFromFactory(
        safeguard,
        getWorkspaceDir(),
        createEventBus(),
        createExtensionRuntime(),
      );
      vi.mocked(buildEmbeddedExtensionFactories).mockImplementation(
        actualExtensions.buildEmbeddedExtensionFactories,
      );
      vi.mocked(guardSessionManager).mockReturnValue(sessionManager);
      limitHistoryTurnsMock.mockImplementation((messages) => messages);
      resolveEffectiveCompactionModeMock.mockReturnValue("safeguard");
      vi.mocked(createAgentSession).mockImplementation(async () =>
        createTestSession({
          model: testModel,
          sessionManager,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false, reserveTokens: 1_024, keepRecentTokens: 1 },
            retry: { enabled: false },
          }),
          resourceLoader: createResourceLoader(extension.handlers),
        }),
      );
      const result = await compactEmbeddedAgentSessionDirect(
        wrappedCompactionArgs({
          config: {
            agents: {
              defaults: {
                compaction: {
                  mode: "safeguard",
                  postCompactionSections: ["Compaction fixture"],
                  recentTurnsPreserve: 0,
                  qualityGuard: { enabled: false },
                },
              },
            },
          },
        }),
      );
      expect(result, result.reason).toMatchObject({ ok: true, compacted: true });
      expect(result.result?.summary).toContain(
        "<workspace-critical-rules>\n## Compaction fixture\nWORKSPACE_RULE_MARKER\n</workspace-critical-rules>",
      );
    });

    it("returns a structured automatic retention skip without reporting compaction failure", async () => {
      const { isBenignCompactionSkipResult } = await import("./compact-reasons.js");
      const { createAgentSession } = await import("../sessions/sdk.js");
      const { guardSessionManager } = await import("../session-tool-result-guard-wrapper.js");
      const { resolveEmbeddedAgentStream } = await import("./stream-resolution.js");
      const { attachCompactionAccountingRecorder } =
        await import("./run/compaction-accounting-bridge.js");
      const sessionManager = SessionManager.inMemory(getWorkspaceDir());
      sessionManager.appendMessage({ role: "user", content: "a".repeat(46_191), timestamp: 1 });
      const assistant = createAssistant(testModel, [{ type: "text", text: "ACK" }]);
      sessionManager.appendMessage({
        ...assistant,
        usage: { ...assistant.usage, input: 19_140, output: 2, totalTokens: 19_142 },
      });
      const pendingUserEntryId = sessionManager.appendMessage({
        role: "user",
        content: "b".repeat(52_602),
        timestamp: 3,
      });
      const contextEngineRuntimeContext = {};
      attachCompactionAccountingRecorder(contextEngineRuntimeContext, { pendingUserEntryId });
      const conversation = () =>
        sessionManager.getBranch().filter((entry) => entry.type === "message");
      const before = structuredClone(conversation());
      const stream = vi.fn<StreamFn>();
      vi.mocked(guardSessionManager).mockReturnValue(sessionManager);
      limitHistoryTurnsMock.mockImplementation((messages) => messages);
      vi.mocked(resolveEmbeddedAgentStream).mockReturnValue({
        streamFn: stream,
        strategy: "session-custom",
      });
      vi.mocked(createAgentSession).mockImplementation(async ({ model }) => {
        if (!model) {
          throw new Error("Expected prepared compaction model");
        }
        return await createTestSession({
          model: { ...testModel, ...model },
          sessionManager,
          settingsManager: SettingsManager.inMemory({
            compaction: { keepRecentTokens: 20_000 },
            retry: { enabled: false },
          }),
          resourceLoader: createResourceLoader(),
        });
      });
      const result = await compactEmbeddedAgentSessionDirect(
        wrappedCompactionArgs({ trigger: "budget", contextEngineRuntimeContext }),
      );
      expect(result).toMatchObject({
        ok: true,
        compacted: false,
        reason: "Nothing to compact (session too small)",
      });
      expect(isBenignCompactionSkipResult(result)).toBe(true);
      expect(conversation()).toEqual(before);
      expect(
        sessionManager.getBranch().filter((entry) => entry.type === "compaction"),
      ).toHaveLength(0);
      expect(stream).not.toHaveBeenCalled();
      expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    });

    it.each([
      ["provider timeout", "request timed out", "fallback"],
      ["intentional quality rejection", undefined, "cancel"],
      ["explicit model timeout", "request timed out", "cancel"],
      // A failed corrective attempt stays a terminal quality cancellation, even on a 408.
      ["corrective 408", "408", "cancel"],
      [
        "reasoning-mandatory rejection",
        "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
        "thinking",
      ],
    ] as const)(
      "keeps model fallback boundaries for %s",
      async (scenario, errorMessage, outcome) => {
        const [
          { createAgentSession },
          { guardSessionManager },
          { resolveEmbeddedAgentStream },
          { buildEmbeddedExtensionFactories },
        ] = await Promise.all([
          import("../sessions/sdk.js"),
          import("../session-tool-result-guard-wrapper.js"),
          import("./stream-resolution.js"),
          import("./extensions.js"),
        ]);
        const fallback = outcome === "fallback";
        const primary = "summary-primary";
        const backup = "summary-backup";
        const explicitModel = scenario === "explicit model timeout";
        const fallbackSummary = [
          "## Decisions",
          "Review the deployment checklist before rollout.",
          "## Open TODOs",
          "Compare the remaining options.",
          "## Constraints/Rules",
          "None.",
          "## Pending user asks",
          "Compare the remaining options.",
          "## Exact identifiers",
          "None.",
        ].join("\n");
        const expectedSummaryRequest = `Latest user request context: ${JSON.stringify("Keep the rollout notes.")}`;
        const sessionManager = SessionManager.inMemory(getWorkspaceDir());
        for (const content of [
          "Review the deployment checklist.",
          "Compare the remaining options.",
          "Keep the rollout notes.",
        ]) {
          sessionManager.appendMessage({ role: "user", content, timestamp: 1 });
        }
        const originalMessages = sessionManager.buildSessionContext().messages;
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: false, reserveTokens: 1_024, keepRecentTokens: 1 },
          retry: { enabled: false },
        });
        const extension = await loadExtensionFromFactory(
          safeguard,
          getWorkspaceDir(),
          createEventBus(),
          createExtensionRuntime(),
        );
        const requestedModels: string[] = [];
        const requestedThinking: Array<string | undefined> = [];
        const stream = vi.fn<StreamFn>((activeModel, _context, options) => {
          requestedModels.push(activeModel.id);
          requestedThinking.push(options?.reasoning);
          const corrective = scenario === "corrective 408";
          const rejected =
            activeModel.id === primary &&
            errorMessage &&
            !(outcome === "thinking" && options?.reasoning === "minimal") &&
            !(corrective && requestedModels.length === 1);
          return createAssistantResultStream(
            rejected
              ? { ...createAssistant(activeModel, [], "error"), errorMessage }
              : createAssistant(activeModel, [
                  {
                    type: "text",
                    text:
                      outcome === "cancel" || corrective
                        ? "Missing required sections."
                        : fallbackSummary,
                  },
                ]),
          );
        });
        vi.mocked(summaryBridge).mockImplementation(generateRealSummary);
        vi.mocked(guardSessionManager).mockReturnValue(sessionManager);
        limitHistoryTurnsMock.mockImplementation((messages) => messages);
        resolveEffectiveCompactionModeMock.mockReturnValue("safeguard");
        vi.mocked(resolveEmbeddedAgentStream).mockReturnValue({
          streamFn: stream,
          strategy: "session-custom",
        });
        vi.mocked(buildEmbeddedExtensionFactories).mockImplementation(({ model }) => {
          setSafeguardRuntime(sessionManager, {
            model,
            recentTurnsPreserve: 0,
            qualityGuardEnabled: true,
            qualityGuardMaxRetries: scenario === "corrective 408" ? 1 : 0,
          });
          return [];
        });
        vi.mocked(createAgentSession).mockImplementation(async ({ model, thinkingLevel }) => {
          if (!model) {
            throw new Error("Expected the prepared compaction model");
          }
          const created = await createTestSession({
            model: {
              ...testModel,
              ...model,
              reasoning: outcome === "thinking",
              maxTokens: 1_024,
            },
            sessionManager,
            settingsManager,
            resourceLoader: createResourceLoader(extension.handlers),
          });
          await created.session.setThinkingLevel(thinkingLevel ?? "off");
          return created;
        });
        const config = {
          agents: {
            defaults: {
              model: { primary: `openai/${primary}`, fallbacks: [`openai/${backup}`] },
              compaction: {
                mode: "safeguard" as const,
                thinkingLevel: "off" as const,
                ...(explicitModel ? { model: `openai/${primary}` } : {}),
                recentTurnsPreserve: 0,
                qualityGuard: { enabled: true, maxRetries: scenario === "corrective 408" ? 1 : 0 },
              },
            },
          },
        };
        const configBefore = structuredClone(config);

        const result = await compactEmbeddedAgentSessionDirect(
          wrappedCompactionArgs({
            provider: "openai",
            model: primary,
            trigger: "overflow",
            config,
          }),
        );

        expect([...new Set(requestedModels)], JSON.stringify(result)).toEqual(
          fallback ? [primary, backup] : [primary],
        );
        expect(config).toEqual(configBefore);
        if (outcome !== "cancel") {
          if (outcome === "thinking") {
            expect([...new Set(requestedThinking)]).toEqual(["off", "minimal"]);
          }
          expect(result).toMatchObject({
            ok: true,
            compacted: true,
            result: { summary: expect.stringContaining(expectedSummaryRequest) },
          });
          expect(result.result?.summary).toContain(
            "Review the deployment checklist before rollout.",
          );
          expect(
            sessionManager.getBranch().findLast((entry) => entry.type === "compaction"),
          ).toMatchObject({
            summary: expect.stringContaining(expectedSummaryRequest),
            details: {
              latestUnresolvedUserRequest: "Keep the rollout notes.",
            },
          });
        } else {
          expect(result).toMatchObject({ ok: false, compacted: false });
          expect(result.reason).toMatch(explicitModel ? /timed out/i : /quality/i);
          expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
            false,
          );
          expect(sessionManager.buildSessionContext().messages).toEqual(originalMessages);
        }
      },
    );
  });
}
