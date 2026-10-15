import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../../config/io.js";
import {
  createSessionEntryWithTranscript,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
  type SelectedSessionActorStorageBinding,
} from "../../../config/sessions/session-actor-storage-binding.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";
import { AuthStorage } from "../../sessions/auth-storage.js";
import { ModelRegistry } from "../../sessions/model-registry.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { validArgs } from "../../tools/ask-user-tool.gateway.test-fixture.js";
import { resetPendingAskUserQuestionsForTest } from "../../tools/ask-user-tool.test-support.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

// Keep native preparation, tool construction, and canonical worker admission;
// only the external question transport is isolated.
const transport = vi.hoisted(() => vi.fn());
// mock-isolation: Keep the native preparation and worker admission; isolate only external Gateway transport.
vi.mock("../../harness/gateway-question-dispatch.runtime.js", () => ({
  callGatewayTool: transport,
}));

beforeEach(() => {
  transport.mockReset();
});
afterEach(() => {
  resetPendingAskUserQuestionsForTest();
  vi.restoreAllMocks();
});

describe("prepared native question custody", () => {
  it.each([
    { name: "persistent", durable: true },
    { name: "legacy", legacy: true, durable: false },
    { name: "detached", detached: true, durable: false },
    { name: "incognito key", incognitoKey: true, durable: false },
    { name: "ordinary key with incognito entry", incognitoEntry: true, durable: false },
  ])("preserves the answer flow for $name", async (scenario) => {
    const config = {
      tools: { allow: ["ask_user"], codeMode: false, toolSearch: { enabled: false } },
    };
    await withOpenClawTestState({ label: "prepared-question" }, async (state) => {
      await state.writeConfig(config);
      await captureRuntimeConfigAsyncReader()();
      const sessionKey = scenario.incognitoKey
        ? "agent:main:dashboard:incognito-question"
        : "agent:main:prepared-question";
      const target = {
        agentId: "main",
        sessionId: "prepared-question",
        sessionKey,
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      const entry = {
        sessionId: target.sessionId,
        updatedAt: 1,
        ...(scenario.legacy ? {} : { lifecycleRevision: "question-generation" }),
        ...(scenario.incognitoEntry || scenario.incognitoKey ? { incognito: true as const } : {}),
      };
      const admission = prepareSystemAgentRunAdmission(config, "prepared-question", "main", "test");
      let prepared: Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>> | undefined;
      let binding: SelectedSessionActorStorageBinding | undefined;
      const yielded = vi.fn();
      transport.mockImplementation(async (method, _options, params) => {
        if (method === "question.request") {
          expect(params.durable).toBe(scenario.durable ? true : undefined);
          return { id: params.id, ...(scenario.durable ? { durable: true } : {}) };
        }
        if (method === "question.waitAnswer") {
          return {
            status: "answered",
            answers: { answers: { deploy_target: ["Staging (Recommended)"] } },
          };
        }
        throw new Error(`Unexpected question operation: ${method}`);
      });
      try {
        const admittedRunContext = await admission.admit("embedded");
        const assertCurrent = resolveAdmittedRunActiveAssertion(admittedRunContext);
        if (!assertCurrent) {
          throw new Error("Expected the native fixture's admitted run authority");
        }
        if (scenario.incognitoKey) {
          binding = await acquireSessionActorStorage(target, {
            authority: { assertCurrent, authorize: assertCurrent },
            lifetime: { assertCurrent, assertReadable: assertCurrent },
            create: true,
          });
          expect(binding?.actor.target.database.kind).toBe("memory");
        }
        const run = async () => {
          if (binding) {
            expect(
              await createSessionEntryWithTranscript(target, () => ({ ok: true, entry }), {
                cwd: state.workspaceDir,
              }),
            ).toMatchObject({ ok: true, entry });
          } else {
            replaceSessionEntrySync(target, entry);
          }
          const authStorage = AuthStorage.inMemory();
          const attempt: EmbeddedRunAttemptInternalParams = {
            config,
            runId: "prepared-question",
            workspaceDir: state.workspaceDir,
            prompt: "Ask which release target to use.",
            timeoutMs: 30_000,
            ...target,
            sessionTarget: target,
            sessionFile: sessionKey,
            ...(scenario.detached ? { sessionPersistence: "detached" } : {}),
            modelId: "test-model",
            provider: "anthropic",
            thinkLevel: "off",
            model: makeProviderModelFixture({
              id: "test-model",
              provider: "anthropic",
              api: "anthropic-messages",
              baseUrl: "https://api.anthropic.com",
            }),
            authProfileStore: { version: 1, profiles: {} },
            authStorage,
            modelRegistry: ModelRegistry.inMemory(authStorage),
            admittedRunContext,
          };
          prepared = await prepareEmbeddedAttemptToolBase({
            attempt,
            agentDir: state.agentDir(),
            setup: createAttemptSetupFixture({ sandboxSessionKey: sessionKey }),
            markCoreToolStage: () => {},
            onYield: yielded,
            runAbortController: new AbortController(),
            runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
            skillUsagePaths: [],
            skillsSnapshot: undefined,
            codeModeSkills: [],
            toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
          });
          const tool = prepared.toolsRaw.find((candidate) => candidate.name === "ask_user");
          expect(tool).toBeDefined();
          expect(prepared.runtimeContinuationStarted).not.toBe(true);
          const result = await tool!.execute("question-call", validArgs);
          expect(transport.mock.calls.map(([method]) => method)).toEqual(
            scenario.durable ? ["question.request"] : ["question.request", "question.waitAnswer"],
          );
          expect(yielded).toHaveBeenCalledTimes(scenario.durable ? 1 : 0);
          expect(prepared.runtimeContinuationStarted).toBe(scenario.durable);
          expect(result).toMatchObject({
            details: { status: scenario.durable ? "waiting" : "answered" },
          });
        };
        if (binding) {
          await runWithSessionActorStorage(binding, run);
        } else {
          await run();
        }
      } finally {
        try {
          await prepared?.releaseTools("test-complete");
          prepared?.toolSurfaceRuntime.cleanup();
        } finally {
          try {
            if (binding) {
              try {
                await binding.actor.release();
              } finally {
                memorySessionActorOwners.closeDatabase(binding);
              }
            }
          } finally {
            admission.close();
          }
        }
      }
    });
  });
});
