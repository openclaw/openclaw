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
import { SessionManager } from "../sessions/session-manager.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import { mockCallArg } from "./compact.hooks.assertions.test-support.js";
import {
  applyExtraParamsToAgentMock,
  hookRunner,
  limitHistoryTurnsMock,
  resolveEffectiveCompactionModeMock,
  sessionAutomaticCompactionMock,
  sessionManualCompactionMock,
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
  const compact = (overrides?: Record<string, unknown>) =>
    compactEmbeddedAgentSessionDirect(wrappedCompactionArgs(overrides));
  const settings = () =>
    SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 1_024, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
  it.each([
    [undefined, "background"],
    ["normal", "normal"],
    ["foreground", "foreground"],
  ] as const)(
    "carries pending input and %s urgency into safeguard recovery",
    async (modelCallUrgency, expectedUrgency) => {
      const { attachCompactionAccountingRecorder } =
        await import("./run/compaction-accounting-bridge.js");
      const runtime = {};
      attachCompactionAccountingRecorder(runtime, {
        pendingRequestState: "unresolved",
      });
      resolveEffectiveCompactionModeMock.mockReturnValue("safeguard");

      const compactionParams = wrappedCompactionArgs({
        trigger: "budget",
        modelCallUrgency,
        contextEngineRuntimeContext: runtime,
      });
      const result = await compactEmbeddedAgentSessionDirect(compactionParams);

      expect(result).toMatchObject({ ok: true, compacted: true });
      expect(mockCallArg(applyExtraParamsToAgentMock, 0, 11)).toMatchObject({
        modelCallUrgency: expectedUrgency,
      });
      expect(sessionAutomaticCompactionMock).toHaveBeenCalledWith(
        compactionParams.customInstructions,
        "unresolved",
        "none",
      );
      expect(sessionManualCompactionMock).not.toHaveBeenCalled();
    },
  );

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
      // Share the reset harness registry while retaining the real session fixture.
      safeguard = (await import("../agent-hooks/compaction-safeguard.js")).default;
      setSafeguardRuntime = (await import("../agent-hooks/compaction-safeguard-runtime.js"))
        .setCompactionSafeguardRuntime;
      summaryBridge = (await import("../sessions/index.js")).generateSummary;
    });

    afterEach(() => {
      vi.mocked(summaryBridge).mockReset().mockResolvedValue("summary");
      limitHistoryTurnsMock.mockImplementation(originalHistoryLimit);
    });

    function createConversation(contents: string[]) {
      const manager = SessionManager.inMemory(getWorkspaceDir());
      for (const content of contents) {
        manager.appendMessage({ role: "user", content, timestamp: 1 });
      }
      return manager;
    }

    async function bindSession(
      sessionManager: SessionManager,
      {
        stream,
        handlers,
        retention,
        reasoning,
      }: {
        stream?: StreamFn;
        handlers?: Parameters<typeof createResourceLoader>[0];
        retention?: number;
        reasoning?: boolean;
      } = {},
    ) {
      const { createAgentSession } = await import("../sessions/sdk.js");
      const { guardSessionManager } = await import("../session-tool-result-guard-wrapper.js");
      vi.mocked(guardSessionManager).mockReturnValue(sessionManager);
      limitHistoryTurnsMock.mockImplementation((messages) => messages);
      if (stream) {
        const { resolveEmbeddedAgentStream } = await import("./stream-resolution.js");
        vi.mocked(resolveEmbeddedAgentStream).mockReturnValue({
          streamFn: stream,
          strategy: "session-custom",
        });
      }
      vi.mocked(createAgentSession).mockImplementation(async ({ model, thinkingLevel }) => {
        const created = await createTestSession({
          model:
            reasoning === undefined && retention === undefined
              ? testModel
              : {
                  ...testModel,
                  ...expectDefined(model, "prepared compaction model"),
                  ...(reasoning === undefined ? {} : { reasoning, maxTokens: 1_024 }),
                },
          sessionManager,
          settingsManager:
            retention === undefined
              ? settings()
              : SettingsManager.inMemory({
                  compaction: { keepRecentTokens: retention },
                  retry: { enabled: false },
                }),
          resourceLoader: await createResourceLoader(handlers, {
            cwd: getWorkspaceDir(),
            agentDir: getWorkspaceDir(),
          }),
        });
        if (reasoning !== undefined) {
          await created.session.setThinkingLevel(thinkingLevel ?? "off");
        }
        return created;
      });
    }

    it("keeps workspace rules in explicit compaction when the Gateway cwd differs", async () => {
      const { buildEmbeddedExtensionFactories } = await import("./extensions.js");
      const actualExtensions =
        await vi.importActual<typeof import("./extensions.js")>("./extensions.js");
      await writeFile(
        join(getWorkspaceDir(), "AGENTS.md"),
        "## Compaction fixture\nWORKSPACE_RULE_MARKER\n",
      );
      const sessionManager = createConversation(["Start.", "Preserve rules.", "Continue."]);
      vi.mocked(buildEmbeddedExtensionFactories).mockImplementation(
        actualExtensions.buildEmbeddedExtensionFactories,
      );
      resolveEffectiveCompactionModeMock.mockReturnValue("safeguard");
      await bindSession(sessionManager, { handlers: safeguard });
      const result = await compact({
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
      });
      expect(result, result.reason).toMatchObject({ ok: true, compacted: true });
      expect(result.result?.summary).toContain(
        "<workspace-critical-rules>\n## Compaction fixture\nWORKSPACE_RULE_MARKER\n</workspace-critical-rules>",
      );
    });

    it("returns a structured automatic retention skip without reporting compaction failure", async () => {
      const { isBenignCompactionSkipResult } = await import("./compact-reasons.js");
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
      const runtime = {};
      attachCompactionAccountingRecorder(runtime, { pendingUserEntryId });
      const conversation = () =>
        sessionManager.getBranch().filter((entry) => entry.type === "message");
      const before = structuredClone(conversation());
      const stream = vi.fn<StreamFn>();
      await bindSession(sessionManager, { stream, retention: 20_000 });
      const result = await compact({ trigger: "budget", contextEngineRuntimeContext: runtime });
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
      ["intentional quality rejection", undefined, "degrade"],
      ["explicit model timeout", "request timed out", "cancel"],
      // A corrective failure reuses the successful earlier summary on the same model.
      ["corrective 408", "408", "degrade"],
      [
        "reasoning-mandatory rejection",
        "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
        "thinking",
      ],
    ] as const)(
      "keeps model fallback boundaries for %s",
      async (scenario, errorMessage, outcome) => {
        const { buildEmbeddedExtensionFactories } = await import("./extensions.js");
        const fallback = outcome === "fallback";
        const primary = "summary-primary";
        const backup = "summary-backup";
        const explicitModel = scenario === "explicit model timeout";
        const fallbackSummary = [
          "## Decisions\nReview the deployment checklist before rollout.",
          "## Open TODOs\nCompare the remaining options.",
          "## Constraints/Rules\nNone.",
          "## Pending user asks\nCompare the remaining options.",
          "## Exact identifiers\nNone.",
        ].join("\n");
        const expectedSummaryRequest = 'Latest user request context: "Keep the rollout notes."';
        const sessionManager = createConversation([
          "Review the deployment checklist.",
          "Compare the remaining options.",
          "Keep the rollout notes.",
        ]);
        const originalMessages = sessionManager.buildSessionContext().messages;
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
          const text =
            outcome === "cancel" || outcome === "degrade" || corrective
              ? "Missing required sections."
              : fallbackSummary;
          return createAssistantResultStream(
            rejected
              ? { ...createAssistant(activeModel, [], "error"), errorMessage }
              : createAssistant(activeModel, [{ type: "text", text }]),
          );
        });
        vi.mocked(summaryBridge).mockImplementation(generateRealSummary);
        resolveEffectiveCompactionModeMock.mockReturnValue("safeguard");
        vi.mocked(buildEmbeddedExtensionFactories).mockImplementation(({ model }) => {
          setSafeguardRuntime(sessionManager, {
            model,
            recentTurnsPreserve: 0,
            qualityGuardEnabled: true,
            qualityGuardMaxRetries: scenario === "corrective 408" ? 1 : 0,
          });
          return [];
        });
        await bindSession(sessionManager, {
          stream,
          handlers: safeguard,
          reasoning: outcome === "thinking",
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

        const result = await compact({
          provider: "openai",
          model: primary,
          trigger: "overflow",
          config,
        });

        expect([...new Set(requestedModels)], JSON.stringify(result)).toEqual(
          fallback ? [primary, backup] : [primary],
        );
        expect(config).toEqual(configBefore);
        if (outcome === "degrade") {
          expect(result).toMatchObject({ ok: true, compacted: true });
          expect(
            sessionManager.getBranch().findLast((entry) => entry.type === "compaction"),
          ).toMatchObject({
            summary: expect.stringContaining("Missing required sections."),
            details: { qualityDegraded: true },
          });
          expect(sessionManager.buildSessionContext().messages).not.toEqual(originalMessages);
        } else if (outcome !== "cancel") {
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
            details: { latestUnresolvedUserRequest: "Keep the rollout notes." },
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
