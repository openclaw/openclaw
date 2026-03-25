/**
 * abb-robot-tool.ts
 * OpenClaw MCP agent tool for controlling actual ABB robots via PC SDK.
 */

import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { ABBController, createController, type ControllerConfig } from "./abb-controller.js";
import { handleAction, type MotionState } from "./abb-robot-tool-actions.js";
import {
  loadRobotConfig,
  identifyRobot,
  type RobotConfig,
} from "./robot-config-loader.js";

const ABB_PLUGIN_VERSION = "1.1.0";

// ── Global state ─────────────────────────────────────────────────────────────

let controller: ABBController | null = null;
let currentConfig: RobotConfig | null = null;
const configCache = new Map<string, RobotConfig>();
const motionState: MotionState = {
  lastTarget: null,
  history: [],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCfg(robotId: string): RobotConfig {
  if (!configCache.has(robotId)) {
    configCache.set(robotId, loadRobotConfig(robotId));
  }
  return configCache.get(robotId)!;
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `❌ abb_robot error: ${message}` }],
    details: { error: message },
  };
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export function createABBRobotTool(pluginConfig: Record<string, unknown>): AnyAgentTool {
  return {
    name: "abb_robot",
    label: "ABB Robot Control",
    description:
      "Control ABB robots via PC SDK. Connect to controllers, scan network for controllers, " +
      "move robots to joint positions, execute RAPID programs, apply presets, " +
      "run motion sequences, query status and event logs, manage speed ratio, " +
      "backup modules, and manage RAPID tasks.",

    parameters: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            // Connection
            "connect", "disconnect", "scan_controllers",
            // Status & info
            "get_status", "get_system_info", "get_service_info", "get_version",
            // Position
            "get_joints", "set_joints", "get_world_position",
            // Speed
            "get_speed", "set_speed",
            // Motion
            "movj", "movj_rapid", "go_home", "movl", "movc",
            // Presets & sequences
            "set_preset", "run_sequence", "list_robots", "list_presets", "list_sequences",
            // RAPID
            "execute_rapid", "load_rapid", "start_program", "stop_program",
            "reset_program_pointer",
            // Tasks & modules
            "list_tasks", "backup_module",
            // Event log
            "get_event_log",
            // Motors
            "motors_on", "motors_off",
            // Robot identification
            "identify_robot",
            // Dance / creative motion
            "dance_two_points", "dance_template",
            // Motion memory
            "get_motion_memory", "reset_motion_memory",
            "get_event_log_categories",
            "get_rapid_variable",
            "set_rapid_variable",
            "get_io_signals",
            "list_rapid_variables",
          ],
          description: "The action to perform.",
        },
        // Connection
        host: { type: "string", description: "Controller IP address or hostname" },
        port: { type: "number", description: "Controller port (default: 7000)" },
        robot_id: { type: "string", description: "Robot configuration ID" },
        // Motion
        joints: { type: "array", items: { type: "number" }, description: "Joint angles in degrees [j1..j6]" },
        start_joints: { type: "array", items: { type: "number" }, description: "Optional MoveJ start joints in degrees" },
        x: { type: "number", description: "Cartesian X coordinate" },
        y: { type: "number", description: "Cartesian Y coordinate" },
        z: { type: "number", description: "Cartesian Z coordinate" },
        rx: { type: "number", description: "Euler X angle (deg)" },
        ry: { type: "number", description: "Euler Y angle (deg)" },
        rz: { type: "number", description: "Euler Z angle (deg)" },
        circ_point: { type: "array", items: { type: "number" }, description: "Midpoint [x,y,z,rx,ry,rz] for movc" },
        to_point: { type: "array", items: { type: "number" }, description: "End point [x,y,z,rx,ry,rz] for movc" },
        speed: { type: "number", description: "Speed: 1-100 for motion actions; 1-7000 for set_speed (mm/s TCP)" },
        zone: { type: "string", description: "Motion zone: fine | z1 | z5 | z10 | z50 (default: fine)" },
        // Presets & sequences
        preset: { type: "string", description: "Named preset key" },
        sequence: { type: "string", description: "Named sequence key" },
        // RAPID
        rapid_code: { type: "string", description: "RAPID program source code" },
        module_name: { type: "string", description: "RAPID module name (default: OpenClawMotionMod)" },
        allow_real_execution: { type: "boolean", description: "Permit execution on real (non-virtual) controllers" },
        // movj_rapid
        task_name: { type: "string", description: "RAPID task name (default: T_ROB1)" },
        program_timeout_ms: { type: "number", description: "Max wait ms for RAPID completion (default: 60000)" },
        // Event log
        category_id: { type: "number", description: "Event log category (0=common, default: 0)" },
        limit: { type: "number", description: "Max entries to return (default: 20)" },
        // Backup
        output_dir: { type: "string", description: "Local directory to write backup file" },
        // Dance
        point_a: { type: "array", items: { type: "number" }, description: "Dance point A joint angles" },
        point_b: { type: "array", items: { type: "number" }, description: "Dance point B joint angles" },
        repeat: { type: "number", description: "A/B oscillation count (default: 2)" },
        max_joint_step: { type: "number", description: "Max interpolation step per joint in degrees (default: 6)" },
        min_samples: { type: "number", description: "Min interpolation samples per segment (default: 2)" },
        interpolation: { type: "string", description: "Interpolation: linear | smoothstep | cosine" },
        auto_connect: { type: "boolean", description: "Auto-connect from previous endpoint to point A (default: true)" },
        return_to_a: { type: "boolean", description: "Return to point A after dance segment (default: false)" },
        template: { type: "string", description: "Dance template: wave | bounce | sway | twist" },
        amplitude: { type: "number", description: "Template amplitude scale 0.1-2.0 (default: 1.0)" },
        beats: { type: "number", description: "Template beats mapped to repeat count (default: 8)" },
        // New actions
        var_name: { type: "string", description: "RAPID variable name" },
        value: { type: "string", description: "RAPID variable value (for set_rapid_variable)" },
        name_filter: { type: "string", description: "IO signal name filter substring" },
        routine_name: { type: "string", description: "PROC name for reset_program_pointer (optional; auto-detected if omitted)" },
      },
      required: ["action"],
    },

    execute: async (_id: string, params: Record<string, unknown>) => {
      const action = String(params["action"] ?? "");

      // ── Version ────────────────────────────────────────────────────────────
      if (action === "get_version") {
        return {
          content: [{ type: "text" as const, text: `abb_robot plugin v${ABB_PLUGIN_VERSION}` }],
          details: { plugin: "abb-robot-control", version: ABB_PLUGIN_VERSION },
        };
      }

      // ── Scan controllers (no connection required) ───────────────────────────
      if (action === "scan_controllers") {
        try {
          // Use a temporary controller instance just for scanning
          const tempCtrl = createController({ host: "" });
          const result = await tempCtrl.scanControllers();
          if (!result.success) return errorResult(String((result as any).error ?? "Scan failed"));
          const lines = result.controllers.map(
            (c) => `  • ${c.ip} — ${c.systemName} (${c.isVirtual ? "virtual" : "real"}) id=${c.id}`
          );
          return {
            content: [{
              type: "text" as const,
              text: result.total === 0
                ? "No ABB controllers found on the network."
                : `Found ${result.total} controller(s):\n${lines.join("\n")}`,
            }],
            details: result,
          };
        } catch (err) {
          return errorResult(`scan_controllers failed: ${String(err)}`);
        }
      }

      // ── Connect ────────────────────────────────────────────────────────────
      if (action === "connect") {
        const host = String(params["host"] ?? pluginConfig["controllerHost"] ?? "");
        if (!host) return errorResult("host parameter or controllerHost config is required");

        const port = Number(params["port"] ?? pluginConfig["controllerPort"] ?? 7000);
        const robotId = String(params["robot_id"] ?? pluginConfig["defaultRobot"] ?? "");

        try {
          if (controller?.isConnected()) await controller.disconnect();

          const config: ControllerConfig = { host, port };
          controller = createController(config);
          await controller.connect();

          const systemName = controller.getSystemName();
          let identifiedRobot = robotId;
          if (!identifiedRobot) {
            const joints = await controller.getJointPositions();
            const jointConfigs = joints.map((_, i) => ({
              index: i, id: `joint${i}`, type: "revolute" as const,
              min: -180, max: 180, home: 0,
            }));
            identifiedRobot = identifyRobot(jointConfigs) || "abb-crb-15000";
          }

          currentConfig = getCfg(identifiedRobot);
          try {
            motionState.lastTarget = await controller.getJointPositions();
            motionState.history.push({
              timestamp: new Date().toISOString(),
              joints: [...motionState.lastTarget],
              source: "connect-sync",
            });
          } catch {
            motionState.lastTarget = null;
          }

          return {
            content: [{
              type: "text" as const,
              text:
                `✓ Connected to ABB controller at ${host}:${port}\n` +
                `System: ${systemName}\n` +
                `Robot: ${currentConfig.manufacturer} ${currentConfig.model} (${currentConfig.id})`,
            }],
            details: { connected: true, host, port, systemName, robotId: currentConfig.id },
          };
        } catch (err) {
          return errorResult(`Connection failed: ${String(err)}`);
        }
      }

      // ── All remaining actions routed through handleAction ──────────────────
      return handleAction(
        action,
        params,
        controller,
        currentConfig,
        pluginConfig,
        getCfg,
        errorResult,
        motionState
      );
    },
  };
}
