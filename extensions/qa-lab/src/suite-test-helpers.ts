import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import type { QaTransportPolicy } from "./qa-transport.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import type { QaSuiteRunParams, QaSuiteScenarioResult } from "./suite-types.js";

type QaSuiteTestScenario = ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];

export function makeQaSuiteTestScenario(
  id: string,
  params: {
    channel?: string;
    config?: Record<string, unknown>;
    plugins?: string[];
    gatewayConfigPatch?: Record<string, unknown>;
    gatewayRuntime?: {
      allowUnhealthyStartup?: boolean;
      forwardHostHome?: boolean;
      preserveDebugArtifacts?: boolean;
    };
    flowKind?: "module" | "steps";
    runtimePairLane?: QaSuiteTestScenario["runtimePairLane"];
    suiteIsolation?: "isolated";
    surface?: string;
    transportPolicy?: QaTransportPolicy;
  } = {},
): QaSuiteTestScenario {
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
      ...(params.channel ? { channel: params.channel } : {}),
      channels: params.channel ? [params.channel] : [],
      ...(params.suiteIsolation ? { suiteIsolation: params.suiteIsolation } : {}),
      ...(params.transportPolicy ? { transportPolicy: params.transportPolicy } : {}),
      ...(params.config ? { config: params.config } : {}),
      flowKind: params.flowKind ?? "steps",
      flow: { steps: [{ name: "noop", actions: [{ assert: "true" }] }] },
    },
  } as QaSuiteTestScenario;
}

export function recordQaSuiteTestResults(
  params:
    | Pick<
        QaSuiteRunParams,
        "evidenceAnchors" | "evidenceContinuation" | "channelId" | "transportId"
      >
    | undefined,
  definitions: readonly QaSuiteTestScenario[],
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
    invocation.complete(id, {
      status,
      entries: [
        {
          test: { kind: "qa-scenario", id: definition.id, title: definition.title },
          coverage: [],
          result: {
            status,
            ...(result.status === "fail" && result.details
              ? { failure: { reason: result.details } }
              : {}),
          },
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
