// Lobster plugin module implements lobster tool behavior.
import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunner,
  type LobsterRunnerParams,
} from "./lobster-runner.js";
type LobsterToolOptions = { runner?: LobsterRunner };

export function createLobsterTool(api: OpenClawPluginApi, options?: LobsterToolOptions) {
  const runner = options?.runner ?? createEmbeddedLobsterRunner();
  return {
    name: "lobster",
    label: "Lobster Workflow",
    description:
      "Run Lobster pipelines as a local-first workflow runtime (typed JSON envelope + resumable approvals).",
    parameters: Type.Object({
      action: Type.Enum(["run", "resume"], { type: "string" }),
      pipeline: Type.Optional(Type.String()),
      argsJson: Type.Optional(Type.String()),
      token: Type.Optional(Type.String()),
      approvalId: Type.Optional(Type.String()),
      approve: Type.Optional(Type.Boolean()),
      cwd: Type.Optional(
        Type.String({
          description:
            "Relative working directory (optional). Must stay within the gateway working directory.",
        }),
      ),
      timeoutMs: optionalPositiveIntegerSchema(),
      maxStdoutBytes: optionalPositiveIntegerSchema(),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const action = typeof params.action === "string" ? params.action.trim() : "";
      if (!action) {
        throw new Error("action required");
      }
      if (action !== "run" && action !== "resume") {
        throw new Error(`Unknown action: ${action}`);
      }

      const cwd = resolveLobsterCwd(params.cwd);
      const timeoutMs = readPositiveIntegerParam(params, "timeoutMs") ?? 20_000;
      const maxStdoutBytes = readPositiveIntegerParam(params, "maxStdoutBytes") ?? 512_000;

      if (api.runtime?.version && api.logger?.debug) {
        api.logger.debug(`lobster plugin runtime=${api.runtime.version}`);
      }

      const runnerParams: LobsterRunnerParams = {
        action,
        ...(typeof params.pipeline === "string" ? { pipeline: params.pipeline } : {}),
        ...(typeof params.argsJson === "string" ? { argsJson: params.argsJson } : {}),
        ...(typeof params.token === "string" ? { token: params.token } : {}),
        ...(typeof params.approvalId === "string" ? { approvalId: params.approvalId } : {}),
        ...(typeof params.approve === "boolean" ? { approve: params.approve } : {}),
        cwd,
        timeoutMs,
        maxStdoutBytes,
      };

      const envelope = await runner.run(runnerParams);
      if (!envelope.ok) {
        throw new Error(envelope.error.message);
      }
      return jsonResult(envelope);
    },
  };
}
