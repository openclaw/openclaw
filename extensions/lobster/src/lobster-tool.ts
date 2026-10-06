import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunnerParams,
} from "./lobster-runner.js";
export function createLobsterTool(api: OpenClawPluginApi) {
  const runner = createEmbeddedLobsterRunner();
  return {
    name: "lobster",
    label: "Lobster Workflow",
    description:
      "Run Lobster workflows with resumable approvals and structured input. For needs_input, ask the user the returned prompt, then resume with their answer as responseJson matching responseSchema. For approvals, resume with approve. Use cancel: true to cancel a checkpoint.",
    parameters: Type.Object({
      action: Type.Enum(["run", "resume"], { type: "string" }),
      pipeline: Type.Optional(Type.String()),
      argsJson: Type.Optional(Type.String()),
      token: Type.Optional(Type.String()),
      approvalId: Type.Optional(Type.String()),
      approve: Type.Optional(Type.Boolean()),
      responseJson: Type.Optional(
        Type.String({
          description: "User's answer as JSON for an input checkpoint. Use instead of approve.",
        }),
      ),
      cancel: Type.Optional(Type.Literal(true)),
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
        ...(typeof params.responseJson === "string" ? { responseJson: params.responseJson } : {}),
        ...(typeof params.cancel === "boolean" ? { cancel: params.cancel } : {}),
        cwd,
        timeoutMs,
        maxStdoutBytes,
      };

      const envelope = await runner.run(runnerParams);
      return jsonResult(envelope);
    },
  };
}
