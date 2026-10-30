import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  resolveConfiguredAgentId,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const loadIndexRuntime = createLazyRuntimeModule(() => import("./index-gateway.runtime.js"));

export function registerMemoryIndexGatewayMethod(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    "memory.index",
    async ({ params, respond, client, signal, hasCurrentClientAuthority }) => {
      const cfg = api.runtime.config.current() as OpenClawConfig;
      let agentId: string;
      try {
        if (
          !params ||
          Array.isArray(params) ||
          Object.keys(params).some((key) => key !== "agentId" && key !== "force") ||
          typeof params.agentId !== "string" ||
          !params.agentId.trim() ||
          (params.force !== undefined && typeof params.force !== "boolean")
        ) {
          throw new Error("memory.index requires agentId and an optional boolean force.");
        }
        agentId = resolveConfiguredAgentId(cfg, params.agentId);
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
        );
        return;
      }
      const assertCurrent = () => {
        signal?.throwIfAborted();
        client?.connectionSignal?.throwIfAborted();
        if (!client || client.invalidated || hasCurrentClientAuthority?.() !== true) {
          throw new Error("Memory maintenance operator authority is no longer current.");
        }
        if (api.runtime.config.current() !== cfg) {
          throw new Error(
            "Memory configuration changed during maintenance; inspect status before retrying.",
          );
        }
      };
      try {
        assertCurrent();
        const { indexMemoryOnGateway } = await loadIndexRuntime();
        assertCurrent();
        const status = await indexMemoryOnGateway({
          cfg,
          agentId,
          force: params.force === true,
          assertCurrent,
          signal: AbortSignal.any(
            [signal, client?.connectionSignal].filter(
              (value): value is AbortSignal => value !== undefined,
            ),
          ),
          acquireLocalService: (...args) => api.runtime.llm.acquireLocalService(...args),
        });
        assertCurrent();
        respond(true, { agentId, status });
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
      }
    },
    { scope: "operator.admin" },
  );
}
