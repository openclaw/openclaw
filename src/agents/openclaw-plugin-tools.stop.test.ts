import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-selection.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { createOperationalRunInstanceRef } from "./operational-run-instance.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

it("Stop on the run reaches a started plugin tool's invocation check", async () => {
  const config: OpenClawConfig = {
    agents: { entries: { main: {} } },
    plugins: { enabled: true, entries: { "stop-probe": { enabled: true } } },
    tools: { codeMode: false, toolSearch: false },
  };
  const artifact = {
    source: "/synthetic/stop-probe/index.js",
    rootDir: "/synthetic/stop-probe",
    origin: "bundled" as const,
    preferBuiltPluginArtifacts: false,
  };
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "stop-probe",
    ...artifact,
    contracts: { tools: ["stop_probe"] },
  });
  bindPluginRuntimeArtifactSelection(record, {
    preferBuiltPluginArtifacts: false,
    runtimeEntry: resolvePluginRuntimeArtifactSelection({ ...artifact, entryKind: "runtime" }),
  });
  builder.registry.plugins.push(record);
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: record.id, ...artifact, enabledByDefault: true, contracts: record.contracts }],
  });
  setPluginRuntimeLoadContext(builder.registry, {
    rawConfig: config,
    config,
    activationSourceConfig: config,
    autoEnabledReasons: {},
    workspaceDir: "/synthetic",
    env: process.env,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    manifestRegistry: snapshot.manifestRegistry,
    metadataSnapshot: snapshot,
  });
  let assertInvocationCurrent: (() => void) | undefined;
  builder.createApi(record, { config, registrationMode: "full" }).registerTool(
    (ctx): AnyAgentTool => {
      assertInvocationCurrent = ctx.assertInvocationCurrent;
      return {
        name: "stop_probe",
        label: "stop_probe",
        description: "stop_probe",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { content: [], details: {} };
        },
      };
    },
    { name: "stop_probe" },
  );
  const stop = new AbortController();
  try {
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:dashboard:stop",
        operationalRunInstance: createOperationalRunInstanceRef("stop-run"),
        approvalSignals: [stop.signal],
      },
      () =>
        withPluginRuntimeRegistryScope(builder.registry, () =>
          resolveOpenClawPluginToolsForOptions({
            options: {
              config,
              workspaceDir: "/synthetic",
              agentSessionKey: "agent:main:dashboard:stop",
              sessionId: "stop-session",
              runId: "stop-run",
              assertInvocationCurrent: () => {},
            },
          }),
        ),
    );
    expect(assertInvocationCurrent).toBeTypeOf("function");
    expect(() => assertInvocationCurrent?.()).not.toThrow();
    stop.abort(new Error("synthetic Stop"));
    expect(() => assertInvocationCurrent?.()).toThrow("synthetic Stop");
  } finally {
    await disposePluginRegistryInstances(builder.registry);
  }
});
