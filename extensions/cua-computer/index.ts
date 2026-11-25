import {
  parseComputerActParamsJSON,
  registerComputerUseProvider,
  type ComputerActParams,
} from "openclaw/plugin-sdk/computer-use";
import { normalizePluginsConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  buildPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { registerCuaDriverDoctorChecks } from "./api.js";
import { createCuaComputerProvider } from "./src/commands.js";
import { verifyInstalledCuaDriverArtifacts } from "./src/driver-artifacts.js";

const COMPUTER_ACT_COMMAND = "computer.act";

const HIGH_RISK_FAMILIES = new Map<
  ComputerActParams["action"],
  NonNullable<OpenClawPluginNodeInvokePolicyContext["risk"]>["family"]
>([
  ["kill_app", "process_termination"],
  ["browser_navigate", "browser_navigation"],
  ["browser_download", "browser_download"],
  ["browser_set_input_files", "browser_file_input"],
  ["start_recording", "recording_start"],
  ["replay_trajectory", "recording_replay"],
  ["escalate_scope", "desktop_scope_escalation"],
]);

const OBSERVATION_ACTIONS = new Set<ComputerActParams["action"]>([
  "list_apps",
  "list_windows",
  "get_accessibility_tree",
  "get_cursor_position",
  "get_window_state",
  "zoom",
  "get_browser_state",
  "get_recording_state",
]);

const CuaComputerConfigSchema = z.strictObject({
  // Keep the shipped daemon setting as a named no-op: strict validation accepts
  // existing config, but direct SDK commands never receive a binary path.
  driverPath: z.string().optional(),
});

export default definePluginEntry({
  id: "cua-computer",
  name: "CUA Computer",
  description: "Experimental CUA Driver computer control for macOS, Windows, and Linux node hosts.",
  configSchema: buildPluginConfigSchema(CuaComputerConfigSchema),
  register(api) {
    const parsed = CuaComputerConfigSchema.safeParse(api.pluginConfig ?? {});
    if (!parsed.success) {
      throw new Error(
        `Invalid cua-computer plugin config: ${parsed.error.issues[0]?.message ?? "invalid config"}`,
      );
    }
    api.registerNodeInvokePolicy({
      commands: [COMPUTER_ACT_COMMAND],
      dangerous: true,
      classifyRisk: ({ command, params }) => {
        if (command !== COMPUTER_ACT_COMMAND) {
          throw new Error("unsupported CUA Computer node command");
        }
        // Node-host owns the exact close envelope. This internal action never enters
        // the model schema, but it still traverses the same classified policy seam.
        if (isRecord(params) && params.action === "__close_execution") {
          return { level: "ordinary", family: "execution_lifecycle" };
        }
        const serialized = JSON.stringify(params);
        if (serialized === undefined) {
          throw new Error("computer action arguments are not serializable");
        }
        const actionParams = parseComputerActParamsJSON(serialized);
        const highRiskFamily = HIGH_RISK_FAMILIES.get(actionParams.action);
        if (highRiskFamily) {
          return { level: "high", family: highRiskFamily };
        }
        if (
          actionParams.action === "browser_dialog" &&
          "dialogAction" in actionParams &&
          actionParams.dialogAction === "inspect"
        ) {
          return { level: "ordinary", family: "observation" };
        }
        return {
          level: "ordinary",
          family: OBSERVATION_ACTIONS.has(actionParams.action) ? "observation" : "input",
        };
      },
      handle: async (context) => {
        if (!context.risk) {
          return {
            ok: false,
            code: "COMPUTER_RISK_UNCLASSIFIED",
            message: "computer.act arguments were not classified before dispatch",
          };
        }
        return await context.invokeNode();
      },
    });
    // Remote policy must not enable local native control. macOS retains its
    // app-gated default; Windows/Linux nodes still require plugin enablement.
    if (
      process.platform !== "darwin" &&
      normalizePluginsConfig(api.config.plugins).entries[api.id]?.enabled !== true
    ) {
      return;
    }
    registerCuaDriverDoctorChecks();
    const artifactVerification = verifyInstalledCuaDriverArtifacts();
    if (!artifactVerification.ok) {
      api.logger.error(artifactVerification.diagnostic);
    }
    registerComputerUseProvider(api, createCuaComputerProvider());
  },
});
