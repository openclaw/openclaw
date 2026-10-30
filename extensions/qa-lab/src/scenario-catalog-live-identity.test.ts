import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { describe, expect, it, vi } from "vitest";
import { splitQaModelRef } from "./model-selection.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";

const SCENARIO = "live-frontier-execution-identity";
const identityCases = [
  ["mock-lane", "requires live-frontier"],
  ["model-fallback", "selected live provider and model"],
  ["missing-identity", "test condition was not met"],
  ["raw-runtime", "pseudonymized runtime identity"],
  ["wrong-run", "exact authenticated ingress"],
  ["enforced-admission", "overstated admission authority"],
  ["prompt-leak", "exposed private content"],
  ["wrong-cli-execution", "different live execution"],
  ["reused-context", "reused one execution identity"],
  ["restart-drift", "changed across Gateway replacement"],
] as const;
type ReplyPredicate = (text: string) => boolean;
const present = <T extends object>(fields: T) => ({ state: "present", ...fields });
const pseudonym = (digit: string) => `hmac-sha256:v1:${"a".repeat(32)}:${digit.repeat(64)}`;

function runIdentityFlow(fault?: (typeof identityCases)[number][0]) {
  let turn = 0;
  let marker = "";
  let restarted = false;
  const makeContext = (runId: string) => ({
    runId,
    contextId: fault === "reused-context" ? "context-1" : `context-${turn}`,
    executionId: `execution-${turn}`,
    ingress: present({ kind: "gateway-client", boundary: "gateway.ws.authenticated-connect" }),
    invoker: { state: "absent" },
    coverageState: "unattributed",
    agentPrincipal: { kind: "agent", principalRef: "qa" },
    agentDefinition: { definitionRef: "qa" },
    trustDomain: present({ domainRef: pseudonym("b") }),
    runtimeInstance: present({
      kind: "embedded",
      runtimeRef: fault === "raw-runtime" ? "private-runtime" : pseudonym("c"),
    }),
  });
  const contexts = new Map<string, ReturnType<typeof makeContext>>();
  const call = vi.fn(async (method: string, params: Record<string, string>) => {
    if (method === "agent") {
      marker = expectDefined(params.message || undefined, "message").replace("Reply exactly: ", "");
      const runId = `run-${++turn}`;
      contexts.set(runId, makeContext(runId));
      return { status: "accepted", runId };
    }
    if (method === "chat.history") {
      const reply = {
        role: "assistant",
        provider: fault === "model-fallback" ? "mock-openai" : "fixture-live",
        model: "fixture-model",
        stopReason: "stop",
        content: [{ type: "text", text: marker }],
      };
      return { messages: [reply] };
    }
    expect(method).toBe("audit.run.inspect");
    const context = expectDefined(
      params.runId
        ? contexts.get(params.runId)
        : [...contexts.values()].find((entry) => entry.executionId === params.executionId),
      "selected execution",
    );
    return {
      run: {
        runId: fault === "wrong-run" ? "foreign-run" : context.runId,
        executionId: context.executionId,
      },
      identity:
        fault === "missing-identity"
          ? { state: "unsupported" }
          : present({
              context: {
                ...context,
                ...(restarted && fault === "restart-drift" ? { contextId: "replacement" } : {}),
              },
            }),
      decisionDisplays: [
        {
          provenance: { state: "verified", producer: "run-admission" },
          decision: {
            outcome: fault === "enforced-admission" ? "allowed" : "not-applicable",
            reasonCode: "run_admission_identity_not_evaluated",
          },
        },
      ],
      ...(fault === "prompt-leak" ? { privateText: marker } : {}),
    };
  });
  const restart = vi.fn(async (mutate: () => Promise<void>) => {
    await mutate();
    restarted = true;
  });
  const runQaCli = vi.fn(async (_env: unknown, args: string[]) => {
    expect(args.slice(0, 2)).toEqual(["audit", "--execution"]);
    const executionId = expectDefined(args[2] || undefined, "execution");
    const inspection = await call("audit.run.inspect", { executionId });
    if (!args.includes("--json")) {
      return "Identity Invoker [absent] Decisions run_admission_identity_not_evaluated not-applicable";
    }
    return fault === "wrong-cli-execution"
      ? { ...inspection, run: { executionId: "foreign-execution" } }
      : inspection;
  });
  const api = {
    env: {
      providerMode: fault === "mock-lane" ? "mock-openai" : "live-frontier",
      primaryModel: "fixture-live/fixture-model",
      gateway: { call, restartAfterStateMutation: restart },
    },
    splitModelRef: splitQaModelRef,
    waitForAgentRun: async (_env: unknown, runId: string) => {
      expect(contexts.has(runId)).toBe(true);
      return { status: "ok" };
    },
    waitForAgentHistoryReply: async (_env: unknown, _key: string, matches: ReplyPredicate) => {
      expect(matches(marker)).toBe(true);
      return marker;
    },
    runQaCli,
  };
  return { call, restart, runQaCli, result: runLoadedScenarioFlow(SCENARIO, { api }) };
}

describe("live-frontier execution identity qualification", () => {
  it("rejects mock selection and admits the operator-selected live model", () => {
    const scenario = readQaScenarioById(SCENARIO);
    const select = (providerMode: "mock-openai" | "live-frontier", scenarioIds?: string[]) =>
      selectQaFlowSuiteScenarios({
        scenarios: [scenario],
        primaryModel: "fixture-live/fixture-model",
        providerMode,
        scenarioIds,
      });
    expect(select("mock-openai")).toEqual([]);
    expect(() => select("mock-openai", [SCENARIO])).toThrow("providerMode=live-frontier");
    expect(select("live-frontier")).toEqual([scenario]);
    expect(scenario.gatewayConfigPatch).toMatchObject({
      logging: { audit: { enabled: true, executionIdentity: true } },
    });
  });

  it("executes the registered flow through admission, CLI inspection, and replacement readback", async () => {
    const fixture = runIdentityFlow();
    await expect(fixture.result).resolves.toMatchObject({ status: "pass" });
    expect(fixture.call.mock.calls.filter(([method]) => method === "agent")).toHaveLength(2);
    expect(fixture.runQaCli).toHaveBeenCalledTimes(4);
    expect(fixture.restart).toHaveBeenCalledOnce();
  });

  it.each(identityCases)(
    "rejects %s evidence from the same executable flow",
    async (fault, message) => {
      await expect(runIdentityFlow(fault).result).rejects.toThrow(message);
    },
  );
});
