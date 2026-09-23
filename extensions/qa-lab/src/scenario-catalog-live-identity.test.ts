import { describe, expect, it, vi } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { selectQaFlowSuiteScenarios, splitModelRef } from "./suite-planning.js";

const SCENARIO = "live-frontier-execution-identity";
type Fault =
  | "none"
  | "mock-lane"
  | "model-fallback"
  | "missing-identity"
  | "raw-runtime"
  | "wrong-run"
  | "enforced-admission"
  | "prompt-leak"
  | "wrong-cli-execution"
  | "reused-context"
  | "restart-drift";

function runIdentityFlow(fault: Fault = "none") {
  let turn = 0;
  let marker = "";
  let restarted = false;
  const contexts = new Map<
    string,
    {
      runId: string;
      contextId: string;
      executionId: string;
      ingress: { state: string; kind: string; boundary: string };
      invoker: { state: string };
      coverageState: string;
      agentPrincipal: { kind: string; principalRef: string };
      agentDefinition: { definitionRef: string };
      trustDomain: { state: string; domainRef: string };
      runtimeInstance: { state: string; kind: string; runtimeRef: string };
    }
  >();
  const call = vi.fn(async (method: string, params: Record<string, string>) => {
    if (method === "agent") {
      turn += 1;
      if (!params.message) {
        throw new Error("live identity proof must send an agent message");
      }
      marker = params.message.replace("Reply exactly: ", "");
      const runId = `run-${turn}`;
      contexts.set(runId, {
        runId,
        contextId: fault === "reused-context" ? "context-1" : `context-${turn}`,
        executionId: `execution-${turn}`,
        ingress: {
          state: "present",
          kind: "gateway-client",
          boundary: "gateway.ws.authenticated-connect",
        },
        invoker: { state: "absent" },
        coverageState: "unattributed",
        agentPrincipal: { kind: "agent", principalRef: "qa" },
        agentDefinition: { definitionRef: "qa" },
        trustDomain: {
          state: "present",
          domainRef: `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`,
        },
        runtimeInstance: {
          state: "present",
          kind: "embedded",
          runtimeRef:
            fault === "raw-runtime"
              ? "private-runtime"
              : `hmac-sha256:v1:${"a".repeat(32)}:${"c".repeat(64)}`,
        },
      });
      return { status: "accepted", runId };
    }
    if (method === "chat.history") {
      return {
        messages: [
          {
            role: "assistant",
            provider: fault === "model-fallback" ? "mock-openai" : "fixture-live",
            model: "fixture-model",
            stopReason: "stop",
            content: [{ type: "text", text: marker }],
          },
        ],
      };
    }
    if (method !== "audit.run.inspect") {
      throw new Error(`unexpected Gateway method ${method}`);
    }
    const context = params.runId
      ? contexts.get(params.runId)
      : [...contexts.values()].find((entry) => entry.executionId === params.executionId);
    if (!context) {
      throw new Error("inspection selected an unknown execution");
    }
    return {
      run: {
        runId: fault === "wrong-run" ? "foreign-run" : context.runId,
        executionId: context.executionId,
      },
      identity:
        fault === "missing-identity"
          ? { state: "unsupported" }
          : {
              state: "present",
              context: {
                ...context,
                ...(restarted && fault === "restart-drift" ? { contextId: "replacement" } : {}),
              },
            },
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
    const executionId = args[2];
    if (!executionId) {
      throw new Error("live identity proof must select an execution");
    }
    const inspection = await call("audit.run.inspect", { executionId });
    if (!args.includes("--json")) {
      return "Identity Invoker [absent] Decisions run_admission_identity_not_evaluated not-applicable";
    }
    if (fault === "wrong-cli-execution") {
      return { ...inspection, run: { executionId: "foreign-execution" } };
    }
    return inspection;
  });
  return {
    call,
    restart,
    runQaCli,
    result: runLoadedScenarioFlow(SCENARIO, {
      api: {
        env: {
          providerMode: fault === "mock-lane" ? "mock-openai" : "live-frontier",
          primaryModel: "fixture-live/fixture-model",
          gateway: { call, restartAfterStateMutation: restart },
        },
        splitModelRef,
        waitForAgentRun: async (_env: unknown, runId: string) => {
          expect(contexts.has(runId)).toBe(true);
          return { status: "ok" };
        },
        waitForAgentHistoryReply: async (
          _env: unknown,
          _session: string,
          predicate: (text: string) => boolean,
        ) => {
          expect(predicate(marker)).toBe(true);
          return marker;
        },
        runQaCli,
      },
    }),
  };
}

describe("live-frontier execution identity qualification", () => {
  it("rejects mock selection and admits the operator-selected live model", () => {
    const scenario = readQaScenarioById(SCENARIO);
    const selection = { scenarios: [scenario], primaryModel: "fixture-live/fixture-model" };
    expect(selectQaFlowSuiteScenarios({ ...selection, providerMode: "mock-openai" })).toEqual([]);
    expect(() =>
      selectQaFlowSuiteScenarios({
        ...selection,
        providerMode: "mock-openai",
        scenarioIds: [SCENARIO],
      }),
    ).toThrow("providerMode=live-frontier");
    expect(selectQaFlowSuiteScenarios({ ...selection, providerMode: "live-frontier" })).toEqual([
      scenario,
    ]);
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

  it.each([
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
  ] as const)("rejects %s evidence from the same executable flow", async (fault, message) => {
    await expect(runIdentityFlow(fault).result).rejects.toThrow(message);
  });
});
