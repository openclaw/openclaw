import { randomUUID } from "node:crypto";
import { nativePluginBindings } from "../../plugins/loader-runtime-load.js";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import type {
  AgentHarnessSessionPreparationV1,
  AgentHarnessSessionPreparationV2,
  AgentHarnessSessionRuntimeParamsV1,
} from "./types.js";

/** Admit native session setup through the same host authority owner, without a prompt, transcript or model attempt. */
export async function prepareAgentHarnessSessionRuntime(params: {
  ownerPluginId: string;
  hostCapabilityVersion?: 1 | 2;
  nativeModelPolicySupport?: "exact";
  sourceAuthority?: AdmittedRunOperatorAuthority;
  input: Omit<
    AgentHarnessSessionRuntimeParamsV1,
    "hostCapabilities" | "authProfileStore" | "runId"
  > & {
    agentId: string;
    agentDir: string;
    config: NonNullable<AgentHarnessSessionRuntimeParamsV1["config"]>;
  };
  assertCurrent: () => void;
}) {
  params.assertCurrent();
  const operationId = "session-prepare:" + randomUUID();
  const admission = prepareSystemAgentRunAdmission(
    params.input.config,
    operationId,
    params.input.agentId,
    "native-session-preparation",
    params.assertCurrent,
    params.sourceAuthority,
  );
  let host: ReturnType<typeof createAgentHarnessHostCapabilities> | undefined;
  const dispose = () => {
    host?.close();
    admission.close();
  };
  try {
    const admittedRunContext = await admission.admit("plugin-harness");
    params.assertCurrent();
    const authProfileStore =
      await nativePluginBindings.authStore.prepareAuthProfileStoreForModelRuntime(
        params.input.agentDir,
        { config: params.input.config },
        params.assertCurrent,
      );
    if (!authProfileStore) {
      throw new Error("Session preparation credentials are unavailable");
    }
    params.assertCurrent();
    host = createAgentHarnessHostCapabilities({
      version: params.hostCapabilityVersion ?? 1,
      attempt: { ...params.input, authProfileStore, runId: operationId, admittedRunContext },
      pluginId: params.ownerPluginId,
      nativeModelPolicySupport: params.nativeModelPolicySupport,
    });
    const owner = host;
    const run = <T>(operation: () => Promise<T>) =>
      owner.runWithScope(async () => {
        params.assertCurrent();
        owner.capabilities.assertActive();
        return await operation();
      });
    const prepared = { ...params.input, authProfileStore, runId: operationId };
    const preparation: AgentHarnessSessionPreparationV1 | AgentHarnessSessionPreparationV2 =
      owner.capabilities.version === 2
        ? {
            version: 2,
            purpose: "mcp-app",
            params: { ...prepared, hostCapabilities: owner.capabilities },
            run,
          }
        : {
            version: 1,
            purpose: "mcp-app",
            params: { ...prepared, hostCapabilities: owner.capabilities },
            run,
          };
    return { preparation, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
