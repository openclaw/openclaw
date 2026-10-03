import { randomUUID } from "node:crypto";
import { nativePluginBindings } from "../../plugins/loader-runtime-load.js";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import type {
  AgentHarnessSessionPreparationV1,
  AgentHarnessSessionRuntimeParamsV1,
} from "./types.js";

/** Admit native session setup through the same host authority owner, without a prompt, transcript or model attempt. */
export async function prepareAgentHarnessSessionRuntime(params: {
  ownerPluginId: string;
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
      attempt: { ...params.input, authProfileStore, runId: operationId, admittedRunContext },
      pluginId: params.ownerPluginId,
      nativeModelPolicySupport: params.nativeModelPolicySupport,
    });
    const owner = host;
    const preparation: AgentHarnessSessionPreparationV1 = {
      version: 1,
      purpose: "mcp-app",
      params: {
        ...params.input,
        authProfileStore,
        runId: operationId,
        hostCapabilities: owner.capabilities,
      },
      run: (operation) =>
        owner.runWithScope(async () => {
          params.assertCurrent();
          owner.capabilities.assertActive();
          return await operation();
        }),
    };
    return {
      preparation,
      dispose: () => {
        owner.close();
        admission.close();
      },
    };
  } catch (error) {
    host?.close();
    admission.close();
    throw error;
  }
}
