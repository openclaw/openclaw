// The real host JSON boundary, reached through the public feature-plugin SDK:
// a probe operation returns a value and the host's output validation decides.
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

type ProbeHandler = (action: { payload: unknown }) => Promise<{ ok: boolean; code?: string }>;

const probeContract = defineFeatureContract({
  pluginId: "knowledge-json-probe",
  operations: {
    echo: {
      kind: "query",
      description: "Return the probed value",
      input: Type.Object({}),
      output: Type.Unknown(),
    },
  },
  events: {},
});

/** Build a checker that reports whether the host accepts `value` as bounded plugin JSON. */
export function hostJsonBoundary(): (value: unknown) => Promise<boolean> {
  let probed: unknown;
  let handler: ProbeHandler | undefined;
  const plugin = defineFeaturePlugin({
    contract: probeContract,
    name: "Knowledge JSON probe",
    description: "Test-only host JSON boundary probe",
    setup: () => ({ echo: async () => probed as never }),
  });
  plugin.register({
    id: probeContract.pluginId,
    registerService() {},
    registerTool() {},
    registerCommand() {},
    session: {
      controls: {
        registerSessionAction(action: { handler: ProbeHandler }) {
          handler = action.handler;
        },
      },
    },
  } as unknown as OpenClawPluginApi);
  return async (value) => {
    probed = value;
    const result = await handler!({ payload: {} });
    if (!result.ok && result.code !== "INVALID_OUTPUT") {
      throw new Error(`Unexpected probe failure: ${JSON.stringify(result)}`);
    }
    return result.ok;
  };
}
