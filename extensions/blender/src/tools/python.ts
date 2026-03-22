import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, optionalStringEnum } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { runBlenderBackground } from "../background.js";
import { createBlenderClient, resolveBlenderConfig } from "../client.js";

const ExecutePythonSchema = Type.Object({
  code: Type.String({
    description: "Python code to execute inside Blender. Has full access to the `bpy` module.",
  }),
  blendFile: Type.Optional(
    Type.String({
      description:
        "Path to a .blend file to open before executing. If omitted, uses the currently open file in the live session or an empty scene in background mode.",
    }),
  ),
  mode: optionalStringEnum(["live", "background"] as const, {
    description:
      "'live' sends code to a running Blender session via the bridge addon (default). 'background' spawns a headless Blender process — useful for batch work when no Blender UI is open.",
  }),
});

export function createExecutePythonTool(api: OpenClawPluginApi) {
  return {
    name: "blender_execute_python",
    label: "Blender: Execute Python",
    description:
      "Execute arbitrary Python code inside Blender with full access to the `bpy` API. " +
      "Use 'live' mode to control an open Blender session, or 'background' for headless batch execution. " +
      "Useful for scripting mesh edits, modifier stacks, material nodes, scene setup, and more.",
    parameters: ExecutePythonSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const code = readStringParam(rawParams, "code", { required: true });
      const blendFile = readStringParam(rawParams, "blendFile");
      const mode = (readStringParam(rawParams, "mode") ?? "live") as "live" | "background";
      const cfg = resolveBlenderConfig(api.pluginConfig);

      if (mode === "background") {
        const result = await runBlenderBackground({
          blenderExecutable: cfg.executablePath,
          blendFile: blendFile ?? undefined,
          pythonCode: code,
        });
        const lines: string[] = [
          result.ok
            ? "Blender background execution succeeded."
            : "Blender background execution failed.",
        ];
        if (result.stdout) lines.push(`STDOUT:\n${result.stdout}`);
        if (result.stderr) lines.push(`STDERR:\n${result.stderr}`);
        return jsonResult(lines.join("\n").trim());
      }

      const client = createBlenderClient({ host: cfg.host, port: cfg.port });
      const status = await client.status();
      if (!status.running) {
        return jsonResult(
          "Blender bridge is not running. Open Blender, enable the OpenClaw Bridge addon, " +
            "or switch to mode='background' for headless execution.",
        );
      }

      const result = await client.execute(code);
      if (!result.ok) {
        return jsonResult(`Blender returned an error:\n${result.error ?? "(no details)"}`);
      }

      const parts: string[] = ["Python executed successfully."];
      if (result.output) parts.push(`Output:\n${result.output}`);
      if (result.result !== undefined)
        parts.push(`Return value: ${JSON.stringify(result.result, null, 2)}`);
      return jsonResult(parts.join("\n"));
    },
  };
}
