import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import type { QaSeedScenarioWithSource as Scenario } from "./scenario-catalog.js";
import type { QaSuiteRunParams, QaSuiteScenarioResult } from "./suite-types.js";

type Flow = Extract<Scenario["execution"], { kind: "flow" }>;
type ScenarioOptions = Partial<
  Pick<Scenario, "plugins" | "gatewayConfigPatch" | "runtimePairLane" | "surface">
> &
  Partial<
    Pick<Flow, "channel" | "config" | "flowKind" | "runtime" | "suiteIsolation" | "transportPolicy">
  > & {
    gatewayRuntime?: Omit<NonNullable<Scenario["gatewayRuntime"]>, "env">;
  };
type EvidenceParams = Pick<
  QaSuiteRunParams,
  "evidenceAnchors" | "evidenceContinuation" | "channelId" | "transportId"
>;

export function makeQaSuiteTestScenario(id: string, params: ScenarioOptions = {}): Scenario {
  return {
    id,
    title: id,
    surface: params.surface ?? "test",
    objective: "test",
    successCriteria: ["test"],
    ...(params.runtimePairLane ? { runtimePairLane: params.runtimePairLane } : {}),
    ...(params.plugins ? { plugins: params.plugins } : {}),
    ...(params.gatewayConfigPatch ? { gatewayConfigPatch: params.gatewayConfigPatch } : {}),
    ...(params.gatewayRuntime ? { gatewayRuntime: params.gatewayRuntime } : {}),
    sourcePath: `qa/scenarios/${id}.yaml`,
    execution: {
      kind: "flow",
      ...(params.runtime ? { runtime: params.runtime } : {}),
      ...(params.channel ? { channel: params.channel } : {}),
      channels: params.channel ? [params.channel] : [],
      ...(params.suiteIsolation ? { suiteIsolation: params.suiteIsolation } : {}),
      ...(params.transportPolicy ? { transportPolicy: params.transportPolicy } : {}),
      ...(params.config ? { config: params.config } : {}),
      flowKind: params.flowKind ?? "steps",
      flow: { steps: [{ name: "noop", actions: [{ assert: "true" }] }] },
    },
  } as Scenario;
}

export function recordQaSuiteTestResults(
  params: EvidenceParams | undefined,
  definitions: readonly Scenario[],
  results: readonly QaSuiteScenarioResult[],
) {
  const anchor = params?.evidenceAnchors?.[0];
  const invocation = createQaEvidenceInvocation({
    scenarios: definitions,
    channel: anchor?.parentCell
      ? anchor.parentCell.channel
      : (params?.channelId ?? params?.transportId ?? "qa-channel"),
    launch: anchor?.launch ?? {
      source: { ref: null, integrity: null },
      runtime: { id: null, version: null },
      package: null,
      protocol: null,
      accountRef: null,
      proofClass: null,
    },
    anchors: params?.evidenceAnchors,
    continuation: params?.evidenceContinuation,
  });
  const scenarios = results.map((result, index) => {
    const definition = definitions[index]!;
    const id = invocation.begin(index);
    const status = result.status === "skip" ? "skipped" : result.status;
    const test = { kind: "qa-scenario" as const, id: definition.id, title: definition.title };
    invocation.complete(id, {
      status,
      entries: [
        {
          test,
          coverage: [],
          result:
            result.status === "fail" && result.details
              ? { status, failure: { reason: result.details } }
              : { status },
        },
      ],
    });
    return { ...result, evidenceOccurrenceId: invocation.select(index, id) };
  });
  return {
    scenarios,
    evidence: invocation.snapshot({ generatedAt: "2026-09-15T00:00:00.000Z" }),
  };
}
