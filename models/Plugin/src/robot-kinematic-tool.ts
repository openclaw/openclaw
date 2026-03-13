/**
 * robot-kinematic-tool.ts
 * OpenClaw MCP agent tool — multi-robot natural-language motion control.
 *
 * Supports simultaneous control of multiple robot viewer instances.
 * Each action can target: a specific robot+instance, all instances of a
 * robot type, or all connected robots.
 */
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import {
  sendToViewer,
  broadcastToRobot,
  getConnectionStatus,
  listKnownRobots,
  getSessionsForRobot,
  getAllSessions,
  type SendOptions,
} from "./ws-bridge.js";
import {
  loadRobotConfig,
  validateJointValues,
  resolvePreset,
  resolveSequence,
  type RobotConfig,
} from "./robot-config-loader.js";

// ── Config cache ─────────────────────────────────────────────────────────────

const configCache = new Map<string, RobotConfig>();

function getCfg(robotId: string): RobotConfig {
  if (!configCache.has(robotId)) {
    configCache.set(robotId, loadRobotConfig(robotId));
  }
  return configCache.get(robotId)!;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `\u274c robot_control error: ${message}` }],
    details: { error: message },
  };
}

/** Resolve robot target options from tool params. */
function resolveOpts(params: Record<string, unknown>): SendOptions {
  const opts: SendOptions = {};
  if (params["robot_id"])    opts.robotId    = String(params["robot_id"]);
  if (params["instance_id"]) opts.instanceId = String(params["instance_id"]);
  return opts;
}

/**
 * Determine the robot config to use for a command.
 * Priority: params.robot_id > first connected session for any robot > default.
 */
function resolveRobotId(params: Record<string, unknown>): string {
  if (params["robot_id"]) return String(params["robot_id"]);
  // Use the first connected session's robot ID
  const all = getAllSessions();
  if (all.length > 0) return all[0].robotId;
  return "abb-crb-15000";
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export function createRobotControlTool(): AnyAgentTool {
  return {
    name: "robot_control",
    label: "Robot Control",
    description:
      "Control robot arms in the 3D kinematic viewer. Supports multiple simultaneous robots. " +
      "Send joint angles, apply named presets or motion sequences, " +
      "switch between robots, list connected robots, or query joint state. " +
      "All joint values are validated against the robot config and clamped if out of range.",

    parameters: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "set_joints",       // set explicit joint angles
            "set_preset",       // apply a named preset
            "run_sequence",     // play a named motion sequence
            "go_home",          // return all joints to home
            "get_state",        // get current joint values from viewer
            "list_robots",      // list known robot configs + connected viewers
            "switch_robot",     // (deprecated alias — just use robot_id parameter)
            "list_presets",     // list presets for a robot config
            "list_sequences",   // list sequences for a robot config
            "list_connections", // list all active viewer connections
          ],
          description: "The action to perform.",
        },
        robot_id: {
          type: "string",
          description:
            "Target robot config ID (e.g. 'abb-crb-15000'). " +
            "If omitted, targets the first connected viewer.",
        },
        instance_id: {
          type: "string",
          description:
            "Target a specific viewer instance ID. When omitted, all instances of " +
            "the robot receive the command (or first instance for commands requiring a reply).",
        },
        joints: {
          type: "array",
          items: { type: "number" },
          description:
            "Joint angle values in degrees (set_joints). " +
            "Out-of-range values are automatically clamped to joint limits.",
        },
        preset: {
          type: "string",
          description: "Named preset key (set_preset).",
        },
        sequence: {
          type: "string",
          description: "Named sequence key (run_sequence).",
        },
      },
      required: ["action"],
    },

    execute: async (_id: string, params: Record<string, unknown>) => {
      const action = String(params["action"] ?? "");
      const opts   = resolveOpts(params);

      // ── list_connections ────────────────────────────────────────────────
      if (action === "list_connections") {
        const status = getConnectionStatus() as Array<Record<string, unknown>>;
        if (status.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No viewers connected. Open robot_kinematic_viewer.html and click Connect." }],
            details: { connected: [] },
          };
        }
        const lines = status.map((s, i) =>
          `  [${i + 1}] ${s["model"]}  instance=${s["instanceId"]}  joints=[${(s["joints"] as number[]).map((v) => v.toFixed(1)).join(", ")}]`
        );
        return {
          content: [{ type: "text" as const, text: `Connected viewers (${status.length}):\n${lines.join("\n")}` }],
          details: { connected: status },
        };
      }

      // ── list_robots ─────────────────────────────────────────────────────
      if (action === "list_robots" || action === "switch_robot") {
        const known     = listKnownRobots();
        const connected = getConnectionStatus() as Array<Record<string, unknown>>;
        const lines: string[] = [
          "Known robot configs:",
          ...known.map((r) => {
            const count = getSessionsForRobot(r).length;
            return `  • ${r}${count > 0 ? ` (${count} viewer${count > 1 ? "s" : ""} connected)` : ""}`;
          }),
          "",
          `Active connections: ${connected.length}`,
          ...connected.map((s) => `  • ${s["model"]} [${s["robotId"]}] instance=${s["instanceId"]}`),
        ];
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { known, connected },
        };
      }

      // ── list_presets ────────────────────────────────────────────────────
      if (action === "list_presets") {
        const robotId = resolveRobotId(params);
        try {
          const cfg     = getCfg(robotId);
          const presets = Object.keys(cfg.presets ?? {});
          return {
            content: [{ type: "text" as const, text: presets.length ? `Presets for ${robotId}:\n${presets.map((p) => `  • ${p}`).join("\n")}` : "No presets defined." }],
            details: { robotId, presets },
          };
        } catch (err) { return errorResult(String(err)); }
      }

      // ── list_sequences ──────────────────────────────────────────────────
      if (action === "list_sequences") {
        const robotId = resolveRobotId(params);
        try {
          const cfg  = getCfg(robotId);
          const seqs = Object.entries(cfg.sequences ?? {}).map(
            ([k, v]) => `  • ${k}${v.description ? ` — ${v.description}` : ""}`
          );
          return {
            content: [{ type: "text" as const, text: seqs.length ? `Sequences for ${robotId}:\n${seqs.join("\n")}` : "No sequences defined." }],
            details: { robotId, sequences: Object.keys(cfg.sequences ?? {}) },
          };
        } catch (err) { return errorResult(String(err)); }
      }

      // ── get_state ────────────────────────────────────────────────────────
      if (action === "get_state") {
        const robotId = resolveRobotId(params);
        try {
          const reply  = JSON.parse(await sendToViewer({ cmd: "get_joints" }, opts)) as { joints?: number[] };
          const joints: number[] = reply.joints ?? [];
          const cfg    = getCfg(robotId);
          const lines  = cfg.joints.map((j, i) =>
            `  ${j.label ?? j.id}: ${(joints[i] ?? 0).toFixed(1)}\u00b0  [${j.min}\u2026${j.max}]`
          );
          return {
            content: [{ type: "text" as const, text: `Joint state — ${robotId} (${cfg.manufacturer} ${cfg.model}):\n${lines.join("\n")}` }],
            details: { robotId, joints },
          };
        } catch (err) {
          return errorResult(`Could not get state — is the viewer connected?\n(${String(err)})`);
        }
      }

      // ── go_home ──────────────────────────────────────────────────────────
      if (action === "go_home") {
        const robotId = resolveRobotId(params);
        try {
          // Broadcast to all instances of this robot (or all if no robotId)
          broadcastToRobot({ cmd: "home" }, opts);
          const count = opts.robotId ? getSessionsForRobot(robotId).length : getAllSessions().length;
          return {
            content: [{ type: "text" as const, text: `Home command sent to ${count} viewer(s) for ${robotId}.` }],
            details: { robotId, viewers: count },
          };
        } catch (err) { return errorResult(`Error: ${String(err)}`); }
      }

      // ── set_preset ───────────────────────────────────────────────────────
      if (action === "set_preset") {
        const robotId    = resolveRobotId(params);
        const presetName = String(params["preset"] ?? "").trim();
        if (!presetName) return errorResult("preset name is required.");
        try {
          const cfg    = getCfg(robotId);
          const joints = resolvePreset(cfg, presetName);
          broadcastToRobot({ cmd: "set_joints", joints }, opts.robotId ? opts : { robotId });
          const lines = cfg.joints.map((j, i) => `  ${j.label ?? j.id}: ${joints[i].toFixed(1)}\u00b0`);
          const count = (opts.robotId ? getSessionsForRobot(robotId) : getAllSessions()).length;
          return {
            content: [{ type: "text" as const, text: `Applied preset "${presetName}" to ${count} viewer(s) of ${robotId}:\n${lines.join("\n")}` }],
            details: { robotId, preset: presetName, joints, viewers: count },
          };
        } catch (err) { return errorResult(String(err)); }
      }

      // ── set_joints ───────────────────────────────────────────────────────
      if (action === "set_joints") {
        const robotId  = resolveRobotId(params);
        const rawJ     = params["joints"];
        if (!Array.isArray(rawJ)) return errorResult("joints array is required.");
        const nums = (rawJ as unknown[]).map(Number);
        if (nums.some(isNaN)) return errorResult("joints must all be numeric.");
        try {
          const cfg = getCfg(robotId);
          const { values, violations } = validateJointValues(cfg, nums);
          broadcastToRobot({ cmd: "set_joints", joints: values }, opts.robotId ? opts : { robotId });
          const lines = cfg.joints.map((j, i) => `  ${j.label ?? j.id}: ${values[i].toFixed(1)}\u00b0`);
          const count = (opts.robotId ? getSessionsForRobot(robotId) : getAllSessions()).length;
          let text = `Joint values applied to ${count} viewer(s) of ${robotId}:\n${lines.join("\n")}`;
          if (violations.length) {
            text += `\n\n\u26a0 Clamped to limits:\n${violations.map((v) => `  ${v}`).join("\n")}`;
          }
          return {
            content: [{ type: "text" as const, text }],
            details: { robotId, joints: values, violations, viewers: count },
          };
        } catch (err) { return errorResult(String(err)); }
      }

      // ── run_sequence ─────────────────────────────────────────────────────
      if (action === "run_sequence") {
        const robotId = resolveRobotId(params);
        const seqName = String(params["sequence"] ?? "").trim();
        if (!seqName) return errorResult("sequence name is required.");
        try {
          const cfg = getCfg(robotId);
          const seq = resolveSequence(cfg, seqName);
          const tgt = opts.robotId ? opts : { robotId };
          for (const step of seq.steps) {
            broadcastToRobot({ cmd: "set_joints", joints: step.joints }, tgt);
            await sleep(step.durationMs);
          }
          broadcastToRobot({ cmd: "home" }, tgt);
          const count = (opts.robotId ? getSessionsForRobot(robotId) : getAllSessions()).length;
          return {
            content: [{ type: "text" as const, text: `Sequence "${seqName}" completed on ${count} viewer(s) of ${robotId} (${seq.steps.length} steps).` }],
            details: { robotId, sequence: seqName, steps: seq.steps.length, viewers: count },
          };
        } catch (err) { return errorResult(String(err)); }
      }

      return errorResult(`Unknown action: "${action}".`);
    },
  };
}
