// Exercises CLI routing receipts at the exact post-admission dispatch boundary.
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { configureExecutionDecisionWorkSink } from "../../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../../audit/execution-decision-work.types.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import { resolveReplyFailureSummary } from "../../auto-reply/reply/agent-runner-failure-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import * as providerRuntime from "../../plugins/provider-hook-runtime.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { createTestOperatorAuthority } from "../admitted-run-context.test-support.js";
import { persistAuthProfileBatch } from "../auth-profiles/upsert-with-lock.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { runPreparedCliAgent } from "../cli-runner.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackServer,
} from "../cli-runner.test-helpers.js";
import {
  providerContextTokenCacheKey,
  replaceDiscoveredContextTokenCache,
} from "../context-cache.js";
import { resetContextWindowCacheForTest } from "../context.test-support.js";
import { FailoverError } from "../failover-error.js";
import { resolveReplyFailoverFacts } from "../failover/request-error-facts.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
} from "./execute.test-support.js";
import { mockCliMcpPreparation } from "./prepare-mcp.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

const auditConfig = {
  logging: { audit: { executionIdentity: true } },
} satisfies OpenClawConfig;

type AuthorityLoss = "close" | "replace";
type Producer = "normal" | "side-question";

function createInterleavedAdmission(params: { kind: AuthorityLoss; runId: string }): {
  admission: PreparedAgentRunAdmission;
  close: () => void;
} {
  let replacement: PreparedAgentRunAdmission | undefined;
  const loseAuthority = () => {
    if (params.kind === "close") {
      admission.close();
      return;
    }
    replacement = prepareAgentRunAdmission({
      cfg: auditConfig,
      operationalRunInstance: createOperationalRunInstanceRef(params.runId),
      facts: {
        runId: params.runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "cli-authority-replacement", state: "present" },
      },
    });
    void replacement.admit("embedded").catch(() => undefined);
  };
  const admission = prepareAgentRunAdmission({
    cfg: auditConfig,
    operationalRunInstance: createOperationalRunInstanceRef(params.runId),
    facts: {
      runId: params.runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "cli-authority-test", state: "present" },
    },
    onAdmitted: () => {
      // Cross both admission promise continuations, then retire the exact claim
      // before the CLI producer resumes from its awaited resolver.
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(loseAuthority)));
    },
  });
  return {
    admission,
    close: () => {
      admission.close();
      replacement?.close();
    },
  };
}

describe("CLI model-routing receipt authority", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  let clearAdmissionSink: (() => void) | undefined;
  let clearDecisionSink: (() => void) | undefined;

  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
    });
    mockCliMcpPreparation({
      getActiveMcpLoopbackRuntime: vi.fn(() => undefined),
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      resolveMcpLoopbackPolicyTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      resolveMcpLoopbackScopedTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      prepareClaudeCliSkillsPlugin: vi.fn(async () => ({
        args: [],
        cleanup: vi.fn(async () => undefined),
      })),
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(async () => {
    clearDecisionSink?.();
    clearAdmissionSink?.();
    clearDecisionSink = undefined;
    clearAdmissionSink = undefined;
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    await fixture.cleanup();
  });

  it.each(["native", "selected", "automatic"] as const)(
    "keeps scheduled CLI credentials under their recorded owner (%s)",
    async (kind) => {
      const agentDir = path.join(fixture.session.dir, "credential-owner");
      const profileId = "test-cli:current";
      await persistAuthProfileBatch({
        agentDir,
        profiles: [
          {
            profileId,
            credential: { type: "api_key", provider: "test-cli", key: "synthetic-cron-key" },
          },
        ],
      });
      const prepareExecution = vi.fn(async () => undefined);
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            ...buildDefaultTestCliBackend(),
            authEpochMode: "profile-only",
            autoSelectAuthProfile: kind === "automatic",
            prepareExecution,
          },
        ],
      });
      const prepared = fixture.prepare({
        agentDir,
        trigger: "cron",
        nativeAuthOnly: true,
        ...(kind === "selected" ? { authProfileId: profileId } : {}),
      });
      if (kind === "native") {
        expect((await prepared).effectiveAuthProfileId).toBeUndefined();
        expect(prepareExecution).toHaveBeenCalledOnce();
      } else {
        await expect(prepared).rejects.toThrow("Automation has no recorded inference account");
        expect(prepareExecution).not.toHaveBeenCalled();
      }
    },
  );

  it("checks the logical model before dispatch", async () => {
    const config = { agents: { defaults: { model: "fixture/allowed" } } };
    const policy = prepareOperatorModelPolicy({ cfg: config, policy: {}, manifestPlugins: [] });
    const source = createTestOperatorAuthority({
      profileId: "fixture-person",
      scopes: ["operator.write"],
      get modelPolicy() {
        return policy;
      },
    });
    const prepareExecution = vi.fn(async () => undefined);
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [{ ...buildDefaultTestCliBackend(), prepareExecution }],
    });
    const admission = prepareSystemAgentRunAdmission(
      config,
      "cli-policy-run",
      "main",
      "test",
      undefined,
      source,
    );
    try {
      await expect(
        fixture.prepare({
          config,
          runId: "cli-policy-run",
          preparedRunAdmission: admission,
          model: "denied",
          requesterModel: { provider: "fixture", model: "denied" },
        }),
      ).rejects.toThrow("operator role cannot use this model");
      expect(prepareExecution).not.toHaveBeenCalled();
      const context = await fixture.prepare({
        config,
        runId: "cli-policy-run",
        preparedRunAdmission: admission,
        model: "allowed",
        requesterModel: { provider: "fixture", model: "allowed" },
      });
      expect(prepareExecution).toHaveBeenCalledOnce();
      expect(context.params.assertCurrent).toBeTypeOf("function");
      expect(context.params.assertCurrent).not.toThrow();
    } finally {
      admission.close();
    }
  });

  it.each<{ kind: AuthorityLoss; producer: Producer }>([
    { kind: "close", producer: "normal" },
    { kind: "replace", producer: "side-question" },
  ])("drops $producer routing work when admission $kind wins the await", async (testCase) => {
    const runId = `run-cli-${testCase.producer}-${testCase.kind}`;
    const authority = createInterleavedAdmission({ kind: testCase.kind, runId });
    const decisionWork: ExecutionDecisionWork[] = [];
    const dispatch = vi.fn();
    clearAdmissionSink = configureExecutionIdentityAdmissionSink(() => true);
    clearDecisionSink = configureExecutionDecisionWorkSink((work) => {
      decisionWork.push(work);
      return true;
    });

    let preparationError: unknown;
    try {
      await fixture
        .prepare({
          runId,
          config: auditConfig,
          preparedRunAdmission: authority.admission,
          ...(testCase.producer === "side-question"
            ? { executionMode: "side-question" as const }
            : {}),
        })
        .then(dispatch)
        .catch((error: unknown) => {
          preparationError = error;
        });
    } finally {
      authority.close();
    }

    // History preparation now admits before the final routing producer. Reusing
    // that context rejects the retired claim before any receipt or dispatch.
    expect.soft(preparationError).toMatchObject({
      message: "This agent run is no longer active. Start a new turn to retry.",
    });
    expect.soft(decisionWork).toEqual([]);
    expect.soft(dispatch).not.toHaveBeenCalled();
  });
});

describe("CLI provider-owned context and failures", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

  beforeEach(() => {
    resetContextWindowCacheForTest();
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(async () => {
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    resetContextWindowCacheForTest();
    supervisorSpawnMock.mockReset();
    await fixture.cleanup();
  });

  it.each(["exit", "result", "throw"])(
    "carries the prepared Google owner through CLI %s into the billing reply",
    async (failure) => {
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          { ...buildDefaultTestCliBackend(), id: "google-gemini-cli", modelProvider: "google" },
        ],
      });
      const context = await fixture.prepare({
        provider: "google-gemini-cli",
        ...(failure === "exit" ? {} : { modelProvider: "google" }),
        disableTrajectory: true,
        config: { plugins: { allow: ["google"], entries: { google: { enabled: true } } } },
      });
      using discovery = vi.spyOn(providerRuntime, "resolveProviderRuntimePluginHandle");
      const refusal = "requires an active Google AI Ultra subscription";
      const message = `This request ${refusal}.`;
      context.preparedBackend.backend.output = "jsonl";
      if (failure === "throw") {
        supervisorSpawnMock.mockRejectedValueOnce(new Error(refusal));
      } else {
        supervisorSpawnMock.mockResolvedValueOnce(
          createManagedRun({
            ...createSuccessfulProcessExit(),
            exitCode: failure === "exit" ? 1 : 0,
            stderr: failure === "exit" ? refusal : "",
            stdout:
              failure === "result"
                ? JSON.stringify({ type: "result", status: "error", error: { message: refusal } }) +
                  "\n"
                : "",
          }),
        );
      }
      const error: unknown = await runPreparedCliAgent(context).catch((caught: unknown) => caught);
      assert.instanceOf(error, FailoverError);
      expect(error).toMatchObject({
        reason: "billing",
        billingError: {
          message,
          actionUrl: "https://one.google.com/about/google-ai-plans/",
        },
      });
      expect(
        resolveReplyFailureSummary({
          error,
          message: error.message,
          facts: resolveReplyFailoverFacts(error, error.message),
        }),
      ).toEqual({ kind: "billing", text: message });
      expect(discovery).not.toHaveBeenCalled();
    },
  );

  it("keeps test-cli stable when another provider loads the same model", async () => {
    const provider = "test-cli";
    const model = "large-model";
    const catalogProvider = "api-provider";
    const prepareExecution = vi.fn<NonNullable<CliBackendPlugin["prepareExecution"]>>(
      async () => undefined,
    );
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          ...buildDefaultTestCliBackend(),
          id: provider,
          modelProvider: catalogProvider,
          prepareExecution,
        },
      ],
    });
    const prepare = () => fixture.prepare({ provider, model });
    const cold = await prepare();
    expect(cold.contextWindowInfo?.tokens).toBe(200_000);

    // Discovery publishes both provider-qualified and bare keys. The latter cannot
    // supply a different runtime's native budget on the next turn.
    const discoveredCache = new Map([
      [model, 1_000_000],
      [providerContextTokenCacheKey(catalogProvider, model), 1_000_000],
    ]);
    replaceDiscoveredContextTokenCache(new Map(discoveredCache));
    const resumed = await prepare();
    expect(resumed.contextWindowInfo?.tokens).toBe(200_000);

    // A provider-owned large window remains usable even without a manifest row.
    discoveredCache.set(providerContextTokenCacheKey(provider, model), 1_000_000);
    replaceDiscoveredContextTokenCache(new Map(discoveredCache));
    const owned = await prepare();
    expect(owned.contextWindowInfo?.tokens).toBe(1_000_000);
    expect(prepareExecution.mock.calls.map(([context]) => context.contextTokenBudget)).toEqual([
      200_000, 200_000, 1_000_000,
    ]);
  });
});
