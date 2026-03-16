/**
 * abb-robot-tool-actions.ts
 * Action handlers for ABB robot tool
 */

import type { ABBController } from "./abb-controller.js";
import type { RobotConfig } from "./robot-config-loader.js";
import {
  validateJointValues,
  resolvePreset,
  resolveSequence,
  listRobots,
} from "./robot-config-loader.js";

export interface MotionState {
  lastTarget: number[] | null;
  history: Array<{
    timestamp: string;
    joints: number[];
    source: string;
  }>;
}

type InterpolationMode = "linear" | "smoothstep" | "cosine";

type DanceExecutionOptions = {
  pointA: number[];
  pointB: number[];
  repeat: number;
  speed: number;
  maxJointStep: number;
  minSamples: number;
  interpolation: InterpolationMode;
  autoConnect: boolean;
  returnToA: boolean;
  moduleName: string;
  source: string;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function equalJoints(a: number[] | null | undefined, b: number[] | null | undefined, epsilon = 1e-3): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > epsilon) return false;
  }
  return true;
}

function interpolateJoints(
  from: number[],
  to: number[],
  maxJointStep: number,
  minSamples = 2,
  mode: InterpolationMode = "cosine"
): number[][] {
  const safeStep = Math.max(0.25, maxJointStep);
  let maxDelta = 0;
  for (let i = 0; i < to.length; i++) {
    maxDelta = Math.max(maxDelta, Math.abs((to[i] ?? 0) - (from[i] ?? 0)));
  }
  const samples = Math.max(minSamples, Math.ceil(maxDelta / safeStep));
  const out: number[][] = [];
  for (let s = 1; s <= samples; s++) {
    const tRaw = s / samples;
    let t = tRaw;
    if (mode === "smoothstep") {
      t = tRaw * tRaw * (3 - 2 * tRaw);
    } else if (mode === "cosine") {
      t = (1 - Math.cos(Math.PI * tRaw)) / 2;
    }
    out.push(to.map((target, idx) => {
      const start = from[idx] ?? 0;
      return start + (target - start) * t;
    }));
  }
  return out;
}

function pushHistory(motionState: MotionState, joints: number[], source: string): void {
  motionState.lastTarget = [...joints];
  motionState.history.push({
    timestamp: new Date().toISOString(),
    joints: [...joints],
    source,
  });
  const maxHistory = 200;
  if (motionState.history.length > maxHistory) {
    motionState.history.splice(0, motionState.history.length - maxHistory);
  }
}

function buildTemplatePoints(
  cfg: RobotConfig,
  template: string,
  amplitude: number
): { pointA: number[]; pointB: number[] } {
  const home = cfg.joints.map((j) => j.home);
  const a = [...home];
  const b = [...home];
  const amp = clamp(amplitude, 0.1, 2.0);
  const setIf = (idx: number, delta: number) => {
    if (idx >= 0 && idx < b.length) b[idx] = (home[idx] ?? 0) + delta * amp;
  };

  switch (template) {
    case "wave":
      setIf(0, 25);
      setIf(3, 18);
      setIf(5, -20);
      break;
    case "bounce":
      setIf(1, -22);
      setIf(2, 18);
      break;
    case "sway":
      setIf(0, -20);
      setIf(4, 15);
      break;
    case "twist":
      setIf(3, 28);
      setIf(5, 32);
      break;
    default:
      throw new Error(`Unknown dance template: ${template}. Available: wave, bounce, sway, twist`);
  }
  return { pointA: a, pointB: b };
}

async function executeContinuousDance(
  controller: ABBController,
  cfg: RobotConfig,
  motionState: MotionState,
  options: DanceExecutionOptions
): Promise<{
  repeat: number;
  speed: number;
  maxJointStep: number;
  minSamples: number;
  interpolation: InterpolationMode;
  waypoints: number;
  start: number[];
  end: number[];
  moduleName: string;
}> {
  const {
    pointA,
    pointB,
    repeat,
    speed,
    maxJointStep,
    minSamples,
    interpolation,
    autoConnect,
    returnToA,
    moduleName,
    source,
  } = options;

  let continuityFrom: number[] | null = null;
  if (autoConnect) {
    continuityFrom = motionState.lastTarget ? [...motionState.lastTarget] : null;
    if (!continuityFrom) {
      continuityFrom = await controller.getJointPositions();
    }
  }

  const waypoints: number[][] = [];
  let cursor = pointA;

  if (continuityFrom && !equalJoints(continuityFrom, pointA)) {
    waypoints.push(...interpolateJoints(continuityFrom, pointA, maxJointStep, minSamples, interpolation));
  } else if (!continuityFrom) {
    waypoints.push([...pointA]);
  }

  cursor = pointA;
  for (let i = 0; i < repeat; i++) {
    const target = i % 2 === 0 ? pointB : pointA;
    waypoints.push(...interpolateJoints(cursor, target, maxJointStep, minSamples, interpolation));
    cursor = target;
  }

  if (returnToA && !equalJoints(cursor, pointA)) {
    waypoints.push(...interpolateJoints(cursor, pointA, maxJointStep, minSamples, interpolation));
    cursor = pointA;
  }

  if (waypoints.length === 0) {
    throw new Error("No motion generated; points are identical and no continuity segment is needed");
  }

  const rapidPoints = waypoints.map((joints, idx) => ({
    joints,
    speed,
    zone: idx === waypoints.length - 1 ? "fine" : "z10",
  }));
  const rapidCode = controller.generateRapidSequence(rapidPoints, moduleName);
  await controller.executeRapidProgram(rapidCode, moduleName);

  pushHistory(motionState, cursor, source);

  return {
    repeat,
    speed,
    maxJointStep,
    minSamples,
    interpolation,
    waypoints: waypoints.length,
    start: pointA,
    end: cursor,
    moduleName,
  };
}

export async function handleAction(
  action: string,
  params: Record<string, unknown>,
  controller: ABBController | null,
  currentConfig: RobotConfig | null,
  pluginConfig: Record<string, unknown>,
  getCfg: (id: string) => RobotConfig,
  errorResult: (msg: string) => any,
  motionState: MotionState
): Promise<any> {

  // Disconnect
  if (action === "disconnect") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected to any controller");
    }
    try {
      await controller.disconnect();
      return {
        content: [{ type: "text" as const, text: "✓ Disconnected from controller" }],
        details: { connected: false },
      };
    } catch (err) {
      return errorResult(`Disconnect failed: ${String(err)}`);
    }
  }

  // Get status
  if (action === "get_status") {
    if (!controller?.isConnected()) {
      return {
        content: [{ type: "text" as const, text: "Not connected to any controller" }],
        details: { connected: false },
      };
    }
    try {
      const status = await controller.getStatus();
      const text = `Controller Status:\n` +
                  `  Connected: ${status.connected}\n` +
                  `  System: ${status.systemName}\n` +
                  `  Operation Mode: ${status.operationMode}\n` +
                  `  Motors: ${status.motorState}\n` +
                  `  RAPID Running: ${status.rapidRunning}`;
      return { content: [{ type: "text" as const, text }], details: status };
    } catch (err) {
      return errorResult(`Failed to get status: ${String(err)}`);
    }
  }

  // Get joints
  if (action === "get_joints") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }
    try {
      const joints = await controller.getJointPositions();
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const lines = cfg.joints.map((j, i) =>
        `  ${j.label ?? j.id}: ${(joints[i] ?? 0).toFixed(2)}° [${j.min}…${j.max}]`
      );
      return {
        content: [{ type: "text" as const, text: `Current Joint Positions:\n${lines.join("\n")}` }],
        details: { joints },
      };
    } catch (err) {
      return errorResult(`Failed to get joints: ${String(err)}`);
    }
  }

  // Set joints
  if (action === "set_joints") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }
    const rawJ = params["joints"];
    if (!Array.isArray(rawJ)) return errorResult("joints array is required");
    const nums = (rawJ as unknown[]).map(Number);
    if (nums.some(isNaN)) return errorResult("joints must all be numeric");

    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const { values, violations } = validateJointValues(cfg, nums);
      const speed = Number(params["speed"] ?? 100);
      await controller.moveToJoints(values, speed);

      const lines = cfg.joints.map((j, i) => `  ${j.label ?? j.id}: ${values[i].toFixed(2)}°`);
      let text = `✓ Moving to joint positions:\n${lines.join("\n")}`;
      if (violations.length) {
        text += `\n\n⚠ Clamped to limits:\n${violations.map(v => `  ${v}`).join("\n")}`;
      }
      pushHistory(motionState, values, "set_joints");
      return { content: [{ type: "text" as const, text }], details: { joints: values, violations } };
    } catch (err) {
      return errorResult(`Move failed: ${String(err)}`);
    }
  }

  // MoveJ (continuous motion from start/current to target with speed)
  if (action === "movj") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }

    const rawTarget = params["joints"];
    if (!Array.isArray(rawTarget)) return errorResult("joints array is required");
    const targetNums = (rawTarget as unknown[]).map(Number);
    if (targetNums.some(isNaN)) return errorResult("joints must all be numeric");

    const rawStart = params["start_joints"];
    if (rawStart !== undefined && !Array.isArray(rawStart)) {
      return errorResult("start_joints must be an array when provided");
    }

    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const targetValidation = validateJointValues(cfg, targetNums);
      const target = targetValidation.values;
      const speed = clamp(Number(params["speed"] ?? 45), 1, 100);
      const maxJointStep = clamp(Number(params["max_joint_step"] ?? 6), 0.25, 45);
      const minSamples = clamp(Number(params["min_samples"] ?? 2), 2, 50);
      const interpolationRaw = String(params["interpolation"] ?? "cosine").toLowerCase();
      const interpolation: InterpolationMode =
        interpolationRaw === "linear" || interpolationRaw === "smoothstep" || interpolationRaw === "cosine"
          ? interpolationRaw
          : "cosine";
      const moduleName = String(params["module_name"] ?? "MoveJSegment");

      let startViolations: string[] = [];
      let start: number[];
      if (Array.isArray(rawStart)) {
        const startNums = (rawStart as unknown[]).map(Number);
        if (startNums.some(isNaN)) return errorResult("start_joints must all be numeric");
        const startValidation = validateJointValues(cfg, startNums);
        start = startValidation.values;
        startViolations = startValidation.violations;
      } else if (motionState.lastTarget && motionState.lastTarget.length === target.length) {
        start = [...motionState.lastTarget];
      } else {
        start = await controller.getJointPositions();
      }

      const waypoints = interpolateJoints(start, target, maxJointStep, minSamples, interpolation);
      const rapidPoints = waypoints.map((joints, idx) => ({
        joints,
        speed,
        zone: idx === waypoints.length - 1 ? "fine" : "z10",
      }));
      const rapidCode = controller.generateRapidSequence(rapidPoints, moduleName);
      await controller.executeRapidProgram(rapidCode, moduleName);

      pushHistory(motionState, target, "movj");

      const violations = [...startViolations, ...targetValidation.violations];
      let text =
        `✓ MoveJ executed\n` +
        `  Speed: v${speed}\n` +
        `  Waypoints: ${waypoints.length}\n` +
        `  Interpolation: ${interpolation}\n` +
        `  End joints: [${target.map(v => v.toFixed(2)).join(", ")}]`;
      if (violations.length > 0) {
        text += `\n\n⚠ Clamped to limits:\n${violations.map(v => `  ${v}`).join("\n")}`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: {
          speed,
          maxJointStep,
          minSamples,
          interpolation,
          start,
          end: target,
          waypoints: waypoints.length,
          moduleName,
          violations,
        },
      };
    } catch (err) {
      return errorResult(`movj failed: ${String(err)}`);
    }
  }

  // Set preset
  if (action === "set_preset") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }
    const presetName = String(params["preset"] ?? "").trim();
    if (!presetName) return errorResult("preset name is required");

    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const joints = resolvePreset(cfg, presetName);
      const speed = Number(params["speed"] ?? 100);
      await controller.moveToJoints(joints, speed);

      const lines = cfg.joints.map((j, i) => `  ${j.label ?? j.id}: ${joints[i].toFixed(2)}°`);
      pushHistory(motionState, joints, `preset:${presetName}`);
      return {
        content: [{ type: "text" as const, text: `✓ Applied preset "${presetName}":\n${lines.join("\n")}` }],
        details: { preset: presetName, joints },
      };
    } catch (err) {
      return errorResult(String(err));
    }
  }

  // Run sequence
  if (action === "run_sequence") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }
    const seqName = String(params["sequence"] ?? "").trim();
    if (!seqName) return errorResult("sequence name is required");

    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const seq = resolveSequence(cfg, seqName);
      const positions = seq.steps.map(step => ({
        joints: step.joints,
        speed: step.speed || 100,
        zone: step.zone || "z10",
      }));
      const rapidCode = controller.generateRapidSequence(positions);
      await controller.executeRapidProgram(rapidCode);
      if (seq.steps.length > 0) {
        pushHistory(motionState, seq.steps[seq.steps.length - 1]!.joints, `sequence:${seqName}`);
      }

      return {
        content: [{ type: "text" as const, text: `✓ Executing sequence "${seqName}" (${seq.steps.length} steps)` }],
        details: { sequence: seqName, steps: seq.steps.length },
      };
    } catch (err) {
      return errorResult(String(err));
    }
  }

  // Go home
  if (action === "go_home") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }
    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const homeJoints = cfg.joints.map(j => j.home);
      await controller.moveToJoints(homeJoints);
      pushHistory(motionState, homeJoints, "go_home");
      return {
        content: [{ type: "text" as const, text: "✓ Moving to home position" }],
        details: { joints: homeJoints },
      };
    } catch (err) {
      return errorResult(`Go home failed: ${String(err)}`);
    }
  }

  // List robots
  if (action === "list_robots") {
    const robots = listRobots();
    const lines = robots.map(r => {
      try {
        const cfg = getCfg(r);
        return `  • ${r} — ${cfg.manufacturer} ${cfg.model} (${cfg.dof} DOF)`;
      } catch {
        return `  • ${r}`;
      }
    });
    return {
      content: [{ type: "text" as const, text: `Available robot configurations:\n${lines.join("\n")}` }],
      details: { robots },
    };
  }

  // List presets
  if (action === "list_presets") {
    const robotId = String(params["robot_id"] ?? currentConfig?.id ?? "abb-crb-15000");
    try {
      const cfg = getCfg(robotId);
      const presets = Object.keys(cfg.presets ?? {});
      return {
        content: [{
          type: "text" as const,
          text: presets.length
            ? `Presets for ${robotId}:\n${presets.map(p => `  • ${p}`).join("\n")}`
            : "No presets defined"
        }],
        details: { robotId, presets },
      };
    } catch (err) {
      return errorResult(String(err));
    }
  }

  // List sequences
  if (action === "list_sequences") {
    const robotId = String(params["robot_id"] ?? currentConfig?.id ?? "abb-crb-15000");
    try {
      const cfg = getCfg(robotId);
      const seqs = Object.entries(cfg.sequences ?? {}).map(
        ([k, v]) => `  • ${k}${v.description ? ` — ${v.description}` : ""}`
      );
      return {
        content: [{
          type: "text" as const,
          text: seqs.length
            ? `Sequences for ${robotId}:\n${seqs.join("\n")}`
            : "No sequences defined"
        }],
        details: { robotId, sequences: Object.keys(cfg.sequences ?? {}) },
      };
    } catch (err) {
      return errorResult(String(err));
    }
  }

  // Execute RAPID
  if (action === "execute_rapid") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }
    const code = String(params["rapid_code"] ?? "");
    if (!code) return errorResult("rapid_code parameter is required");
    const moduleName = String(params["module_name"] ?? "MainModule");

    try {
      await controller.executeRapidProgram(code, moduleName);
      return {
        content: [{ type: "text" as const, text: `✓ Executing RAPID program (${moduleName})` }],
        details: { moduleName },
      };
    } catch (err) {
      return errorResult(`RAPID execution failed: ${String(err)}`);
    }
  }

  // Load RAPID (load without executing)
  if (action === "load_rapid") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }
    const code = String(params["rapid_code"] ?? "");
    if (!code) return errorResult("rapid_code parameter is required");
    const moduleName = String(params["module_name"] ?? "MainModule");

    try {
      await controller.loadRapidProgram(code, moduleName);
      return {
        content: [{ type: "text" as const, text: `✓ RAPID program loaded (${moduleName})` }],
        details: { moduleName },
      };
    } catch (err) {
      return errorResult(`RAPID load failed: ${String(err)}`);
    }
  }

  // Start RAPID program
  if (action === "start_program") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }
    try {
      await controller.startRapid();
      return {
        content: [{ type: "text" as const, text: "✓ RAPID program started" }],
        details: { running: true },
      };
    } catch (err) {
      return errorResult(`Start program failed: ${String(err)}`);
    }
  }

  // Stop RAPID program
  if (action === "stop_program") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }
    try {
      await controller.stopRapid();
      return {
        content: [{ type: "text" as const, text: "✓ RAPID program stopped" }],
        details: { running: false },
      };
    } catch (err) {
      return errorResult(`Stop program failed: ${String(err)}`);
    }
  }

  // Identify robot from controller data
  if (action === "identify_robot") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }
    try {
      const liveJoints = await controller.getJointPositions();
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const jointConfigs = liveJoints.map((_, i) => {
        const jCfg = cfg.joints[i];
        return {
          index: i,
          id: jCfg?.id ?? `joint${i}`,
          type: (jCfg?.type ?? "revolute") as "revolute" | "prismatic",
          min: jCfg?.min ?? -180,
          max: jCfg?.max ?? 180,
          home: jCfg?.home ?? 0,
        };
      });
      const { identifyRobot } = await import("./robot-config-loader.js");
      const identified = identifyRobot(jointConfigs);
      if (identified) {
        const identifiedCfg = getCfg(identified);
        return {
          content: [{
            type: "text" as const,
            text: `✓ Robot identified: ${identifiedCfg.manufacturer} ${identifiedCfg.model} (${identified})`,
          }],
          details: { robotId: identified, manufacturer: identifiedCfg.manufacturer, model: identifiedCfg.model, dof: liveJoints.length },
        };
      }
      return {
        content: [{ type: "text" as const, text: `⚠ Could not identify robot from controller data (${liveJoints.length} DOF). Specify robot_id manually.` }],
        details: { identified: false, dof: liveJoints.length },
      };
    } catch (err) {
      return errorResult(`Identify robot failed: ${String(err)}`);
    }
  }

  // Motors on/off
  if (action === "motors_on" || action === "motors_off") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }
    try {
      const state = action === "motors_on" ? "ON" : "OFF";
      await controller.setMotors(state);
      return {
        content: [{ type: "text" as const, text: `✓ Motors turned ${state.toLowerCase()}` }],
        details: { motorState: state },
      };
    } catch (err) {
      return errorResult(`Failed to set motors: ${String(err)}`);
    }
  }

  if (action === "get_motion_memory") {
    return {
      content: [{
        type: "text" as const,
        text:
          `Motion memory:\n` +
          `  Last target: ${motionState.lastTarget ? `[${motionState.lastTarget.map(v => v.toFixed(2)).join(", ")}]` : "(none)"}\n` +
          `  History entries: ${motionState.history.length}`,
      }],
      details: {
        lastTarget: motionState.lastTarget,
        historyCount: motionState.history.length,
        recent: motionState.history.slice(-10),
      },
    };
  }

  if (action === "reset_motion_memory") {
    motionState.lastTarget = null;
    motionState.history = [];
    return {
      content: [{ type: "text" as const, text: "✓ Motion memory reset" }],
      details: { reset: true },
    };
  }

  if (action === "dance_two_points") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }

    const rawA = params["point_a"];
    const rawB = params["point_b"];
    if (!Array.isArray(rawA) || !Array.isArray(rawB)) {
      return errorResult("point_a and point_b arrays are required");
    }

    const pointANums = (rawA as unknown[]).map(Number);
    const pointBNums = (rawB as unknown[]).map(Number);
    if (pointANums.some(isNaN) || pointBNums.some(isNaN)) {
      return errorResult("point_a and point_b must contain only numeric values");
    }

    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const pointAValidation = validateJointValues(cfg, pointANums);
      const pointBValidation = validateJointValues(cfg, pointBNums);
      const pointA = pointAValidation.values;
      const pointB = pointBValidation.values;
      const violations = [...pointAValidation.violations, ...pointBValidation.violations];

      const repeat = clamp(Number(params["repeat"] ?? 2), 1, 64);
      const speed = clamp(Number(params["speed"] ?? 45), 1, 100);
      const maxJointStep = clamp(Number(params["max_joint_step"] ?? 6), 0.25, 45);
      const minSamples = clamp(Number(params["min_samples"] ?? 2), 2, 50);
      const interpolationRaw = String(params["interpolation"] ?? "cosine").toLowerCase();
      const interpolation: InterpolationMode =
        interpolationRaw === "linear" || interpolationRaw === "smoothstep" || interpolationRaw === "cosine"
          ? interpolationRaw
          : "cosine";
      const autoConnect = params["auto_connect"] !== false;
      const returnToA = params["return_to_a"] === true;
      const moduleName = String(params["module_name"] ?? "DanceSegment");
      const result = await executeContinuousDance(controller, cfg, motionState, {
        pointA,
        pointB,
        repeat,
        speed,
        maxJointStep,
        minSamples,
        interpolation,
        autoConnect,
        returnToA,
        moduleName,
        source: "dance_two_points",
      });

      let text =
        `✓ Executing continuous dance segment\n` +
        `  Repeat: ${result.repeat}\n` +
        `  Waypoints: ${result.waypoints}\n` +
        `  Speed: v${result.speed}\n` +
        `  Interpolation: ${result.interpolation}\n` +
        `  End joint: [${result.end.map(v => v.toFixed(2)).join(", ")}]`;
      if (violations.length > 0) {
        text += `\n\n⚠ Clamped to limits:\n${violations.map(v => `  ${v}`).join("\n")}`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: {
          repeat,
          speed,
          maxJointStep,
          minSamples,
          interpolation,
          waypoints: result.waypoints,
          start: result.start,
          end: result.end,
          moduleName,
          violations,
        },
      };
    } catch (err) {
      return errorResult(`dance_two_points failed: ${String(err)}`);
    }
  }

  if (action === "dance_template") {
    if (!controller?.isConnected()) {
      return errorResult("Not connected. Use 'connect' action first.");
    }
    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const template = String(params["template"] ?? "wave").toLowerCase();
      const amplitude = clamp(Number(params["amplitude"] ?? 1.0), 0.1, 2.0);
      const beats = clamp(Number(params["beats"] ?? 8), 2, 64);
      const speed = clamp(Number(params["speed"] ?? 45), 1, 100);
      const maxJointStep = clamp(Number(params["max_joint_step"] ?? 6), 0.25, 45);
      const minSamples = clamp(Number(params["min_samples"] ?? 2), 2, 50);
      const interpolationRaw = String(params["interpolation"] ?? "cosine").toLowerCase();
      const interpolation: InterpolationMode =
        interpolationRaw === "linear" || interpolationRaw === "smoothstep" || interpolationRaw === "cosine"
          ? interpolationRaw
          : "cosine";
      const autoConnect = params["auto_connect"] !== false;
      const returnToA = params["return_to_a"] === true;
      const moduleName = String(params["module_name"] ?? `DanceTemplate_${template}`);

      const { pointA, pointB } = buildTemplatePoints(cfg, template, amplitude);
      const repeat = Math.max(1, Math.floor(beats / 2));
      const result = await executeContinuousDance(controller, cfg, motionState, {
        pointA,
        pointB,
        repeat,
        speed,
        maxJointStep,
        minSamples,
        interpolation,
        autoConnect,
        returnToA,
        moduleName,
        source: `dance_template:${template}`,
      });

      return {
        content: [{
          type: "text" as const,
          text:
            `✓ Executing dance template '${template}'\n` +
            `  Beats: ${beats}\n` +
            `  Repeat: ${result.repeat}\n` +
            `  Waypoints: ${result.waypoints}\n` +
            `  Speed: v${result.speed}\n` +
            `  Interpolation: ${result.interpolation}`,
        }],
        details: {
          template,
          amplitude,
          beats,
          repeat: result.repeat,
          speed: result.speed,
          maxJointStep: result.maxJointStep,
          minSamples: result.minSamples,
          interpolation: result.interpolation,
          waypoints: result.waypoints,
          start: result.start,
          end: result.end,
          moduleName: result.moduleName,
        },
      };
    } catch (err) {
      return errorResult(`dance_template failed: ${String(err)}`);
    }
  }

  return errorResult(`Unknown action: "${action}"`);
}
