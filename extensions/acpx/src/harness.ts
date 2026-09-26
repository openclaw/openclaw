import { inspectAgentModels } from "acpx/runtime";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { finiteSecondsToTimerSafeMilliseconds } from "openclaw/plugin-sdk/number-runtime";
import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "../runtime-api.js";
import { resolveAcpxPluginConfig } from "./config.js";
import { createAcpxAgentRegistry } from "./native-agents.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";

const LOCAL_TOOL_REQUIREMENTS = ["ls", "read", "write", "edit", "exec"] as const;
// Native settings can enable these tools outside OpenClaw's control. Admission
// must cover the reachable tool set, including provider-conditional tools.
const NATIVE_TOOL_REQUIREMENTS = {
  opencode: [
    ...LOCAL_TOOL_REQUIREMENTS,
    "apply_patch",
    "web_fetch",
    "web_search",
    "sessions_spawn",
    "sessions_send",
    "ask_user",
  ],
  qwen: [
    ...LOCAL_TOOL_REQUIREMENTS,
    "process",
    "sessions_spawn",
    "sessions_send",
    "sessions_list",
    "subagents",
    "web_fetch",
    "web_search",
    "view_image",
    "ask_user",
    "automations",
    "image_generate",
  ],
  pi: LOCAL_TOOL_REQUIREMENTS,
  kilocode: [
    ...LOCAL_TOOL_REQUIREMENTS,
    "apply_patch",
    "web_fetch",
    "web_search",
    "sessions_spawn",
    "sessions_send",
    "sessions_search",
    "sessions_history",
    "memory_search",
    "memory_get",
    "message",
    "image_generate",
  ],
  copilot: [
    ...LOCAL_TOOL_REQUIREMENTS,
    "apply_patch",
    "process",
    "browser",
    "web_fetch",
    "web_search",
    "sessions_spawn",
    "sessions_send",
    "sessions_list",
    "sessions_search",
    "sessions_history",
    "subagents",
    "memory_search",
    "memory_get",
    "view_image",
    "ask_user",
  ],
} as const;

export function createAcpAgentHarness(params: {
  agent: keyof typeof NATIVE_TOOL_REQUIREMENTS;
  label: string;
  isEnabled: () => boolean;
  shutdown: () => Promise<void> | void;
  api: OpenClawPluginApi;
  getRuntime: (context: OpenClawPluginServiceContext) => Promise<CompleteAcpRuntime>;
}): AgentHarnessV2 {
  const id = `acp-${params.agent}`;
  const generation = new AbortController();
  let agentRegistry: ReturnType<typeof createAcpxAgentRegistry> | undefined;
  const inspectAgent = () =>
    (agentRegistry ??= createAcpxAgentRegistry(params.api.pluginConfig)).inspect(params.agent);
  const runtimeFor = (workspaceDir?: string) =>
    params.getRuntime({
      config: params.api.config,
      workspaceDir,
      stateDir: params.api.runtime.state.resolveStateDir(),
      logger: params.api.logger,
    });
  const resource = (agentId: string, sessionId: string) =>
    `agent:${agentId}:harness:${id}:${sessionId}`;
  const retire = async (
    input: { agentId: string; sessionId: string; sessionKey: string },
    assertCurrent: () => void,
  ) => {
    const runtime = await runtimeFor();
    assertCurrent();
    const handle = await runtime.findSession({
      sessionKey: resource(input.agentId, input.sessionId),
      agent: params.agent,
      agentId: input.agentId,
    });
    assertCurrent();
    if (handle) {
      const ownedHandle = {
        ...handle,
        bridgeSession: { sessionKey: input.sessionKey, agentId: input.agentId, native: true },
      };
      await runtime.prepareFreshSession({ handle: ownedHandle });
    }
  };
  return {
    id,
    label: params.label,
    autoSelection: { providerIds: [] },
    authBootstrap: "harness",
    executionEnvironment: "host-only",
    conversationToolPolicyNativeTools: NATIVE_TOOL_REQUIREMENTS[params.agent],
    supports: ({ requestedRuntime, modelProvider }) => {
      if (!params.isEnabled()) {
        return { supported: false, reason: `${params.label} is disabled in Models settings.` };
      }
      if (requestedRuntime !== id) {
        return { supported: false, reason: `Choose ${params.label} explicitly` };
      }
      if (modelProvider?.endpointOverrides === undefined) {
        return { supported: false, reason: "Update OpenClaw to use this native runtime." };
      }
      if (
        modelProvider?.requestTransportOverrides === "present" ||
        modelProvider?.endpointOverrides === "present" ||
        modelProvider?.preparedAuth?.source === "profile" ||
        modelProvider?.preparedAuth?.source === "direct" ||
        (modelProvider?.runtimePolicy && !modelProvider.runtimePolicy.compatibleIds.includes(id))
      ) {
        return {
          supported: false,
          reason: `${params.label} owns its login and cannot use an OpenClaw credential or custom provider transport`,
        };
      }
      return { supported: true, priority: 100 };
    },
    async loadModelCatalog(input) {
      generation.signal.throwIfAborted();
      if (!params.isEnabled()) {
        return { entries: [] };
      }
      const inspection = inspectAgent();
      if (inspection?.launch.kind !== "installed") {
        return { entries: [] };
      }
      const config = resolveAcpxPluginConfig({
        rawConfig: params.api.pluginConfig,
        workspaceDir: input.workspaceDir,
      });
      try {
        const models = await inspectAgentModels({
          agentCommand: inspection.launch.argv,
          cwd: input.workspaceDir ?? config.cwd,
          signal: generation.signal,
          timeoutMs:
            config.timeoutSeconds === undefined
              ? undefined
              : (finiteSecondsToTimerSafeMilliseconds(config.timeoutSeconds) ?? 1),
        });
        generation.signal.throwIfAborted();
        if (!params.isEnabled()) {
          return { entries: [] };
        }
        return {
          entries: (models?.availableModels ?? []).map((model) => ({
            provider: id,
            id: model.modelId,
            name: model.name,
            nativeRuntime: id,
          })),
          outcomes: [{ provider: id, status: "ready" as const }],
        };
      } catch (error) {
        generation.signal.throwIfAborted();
        if (!params.isEnabled()) {
          return { entries: [] };
        }
        // ACP SDK RequestError.authRequired reserves this code/message pair;
        // a generic JSON-RPC server error with the same code is not an auth rejection.
        const authRequired =
          error instanceof Error &&
          error.name === "RequestError" &&
          "code" in error &&
          error.code === -32000 &&
          (error.message === "Authentication required" ||
            error.message.startsWith("Authentication required: "));
        return {
          entries: [],
          outcomes: [
            {
              provider: id,
              status: authRequired ? ("auth-rejected" as const) : ("unavailable" as const),
              rejectionScope: "catalog" as const,
            },
          ],
        };
      }
    },
    async runAttempt(input) {
      generation.signal.throwIfAborted();
      if (!params.isEnabled()) {
        throw new Error(
          `${params.label} is disabled. Enable it in Models settings to start a turn.`,
        );
      }
      const inspection = inspectAgent();
      if (inspection?.launch.kind !== "installed") {
        throw new Error(`${params.label} is not installed; refresh the model catalog`);
      }
      const runtime = await runtimeFor(input.workspaceDir);
      generation.signal.throwIfAborted();
      const { runAcpHarnessAttempt } = await import("./harness-attempt.js");
      return await runAcpHarnessAttempt({
        input,
        runtime,
        agent: params.agent,
        harnessId: id,
        label: params.label,
        command: inspection.launch.argv,
        generationSignal: generation.signal,
      });
    },
    async reset(input) {
      if (input.agentId && input.sessionId && input.sessionKey) {
        await retire(
          { agentId: input.agentId, sessionId: input.sessionId, sessionKey: input.sessionKey },
          () => generation.signal.throwIfAborted(),
        );
      }
    },
    async withSessionDeletion(input, run) {
      let committed = false;
      try {
        return await run({
          commit: () => {
            committed = true;
          },
          rollback: () => {
            committed = false;
          },
        });
      } finally {
        if (committed) {
          await retire(input, input.assertCurrent);
        }
      }
    },
    async dispose() {
      generation.abort();
      await params.shutdown();
    },
  };
}
