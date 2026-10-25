// Exercises CLI routing receipts at the exact post-admission dispatch boundary.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureExecutionDecisionWorkSink } from "../../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../../audit/execution-decision-work.types.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { persistAuthProfileBatch } from "../auth-profiles/upsert-with-lock.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import {
  providerContextTokenCacheKey,
  replaceDiscoveredContextTokenCache,
} from "../context-cache.js";
import { resetContextWindowCacheForTest } from "../context.test-support.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { emptyCliPreparation, setRawCliBackendForPrepareTest } from "./prepare-mcp.test-support.js";
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

function createInterleavedAdmission(params: { kind: AuthorityLoss; runId: string }) {
  let replacement: PreparedAgentRunAdmission | undefined;
  const prepare = (boundary: string, onAdmitted?: () => void) =>
    prepareAgentRunAdmission({
      cfg: auditConfig,
      operationalRunInstance: createOperationalRunInstanceRef(params.runId),
      facts: {
        runId: params.runId,
        agentId: "main",
        ingress: { kind: "system", boundary, state: "present" },
      },
      onAdmitted,
    });
  const loseAuthority = () => {
    if (params.kind === "close") {
      admission.close();
      return;
    }
    replacement = prepare("cli-authority-replacement");
    void replacement.admit("embedded").catch(() => undefined);
  };
  const admission = prepare("cli-authority-test", () => {
    // Cross both admission promise continuations, then retire the exact claim
    // before the CLI producer resumes from its awaited resolver.
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(loseAuthority)));
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
    resetContextWindowCacheForTest();
    setRawCliBackendForPrepareTest(buildDefaultTestCliBackend());
    setCliRunnerPrepareTestDeps(emptyCliPreparation());
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
    resetContextWindowCacheForTest();
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
      setRawCliBackendForPrepareTest({
        ...buildDefaultTestCliBackend(),
        authEpochMode: "profile-only",
        autoSelectAuthProfile: kind === "automatic",
        prepareExecution,
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

  it("checks the logical model before CLI preparation and retains a current model guard through dispatch", async () => {
    const config = { agents: { defaults: { model: "fixture/allowed" } } };
    let policy = prepareOperatorModelPolicy({ cfg: config, policy: {}, manifestPlugins: [] });
    const source = createAdmittedRunOperatorAuthority({
      profileId: "fixture-person",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      get modelPolicy() {
        return policy;
      },
    });
    const prepareExecution = vi.fn(async () => undefined);
    setRawCliBackendForPrepareTest({ ...buildDefaultTestCliBackend(), prepareExecution });
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
      policy = prepareOperatorModelPolicy({
        cfg: config,
        policy: { allow: [] },
        manifestPlugins: [],
      });
      expect(context.params.assertCurrent).toThrow("operator role cannot use this model");
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
      message: "prepared execution authority is no longer active",
    });
    expect.soft(decisionWork).toEqual([]);
    expect.soft(dispatch).not.toHaveBeenCalled();
  });

  it("keeps CLI context discovery owned by its provider across turns", async () => {
    const provider = "test-cli";
    const model = "large-model";
    setRawCliBackendForPrepareTest({
      ...buildDefaultTestCliBackend(),
      modelProvider: "api-provider",
    });
    const prepare = async () =>
      (await fixture.prepare({ provider, model })).contextWindowInfo?.tokens;
    expect(await prepare()).toBe(200_000);
    const discovered = new Map([
      [model, 1_000_000],
      [providerContextTokenCacheKey("api-provider", model), 1_000_000],
    ]);
    replaceDiscoveredContextTokenCache(new Map(discovered));
    expect(await prepare()).toBe(200_000);
    discovered.set(providerContextTokenCacheKey(provider, model), 1_000_000);
    replaceDiscoveredContextTokenCache(new Map(discovered));
    expect(await prepare()).toBe(1_000_000);
  });
});
