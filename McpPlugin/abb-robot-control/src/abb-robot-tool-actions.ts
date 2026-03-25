/**
 * abb-robot-tool-actions.ts
 * Action handlers for the ABB robot tool.
 * Covers all actions registered in abb-robot-tool.ts.
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

function equalJoints(
  a: number[] | null | undefined,
  b: number[] | null | undefined,
  epsilon = 1e-3
): boolean {
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
    out.push(
      to.map((target, idx) => {
        const start = from[idx] ?? 0;
        return start + (target - start) * t;
      })
    );
  }
  return out;
}

function pushHistory(
  motionState: MotionState,
  joints: number[],
  source: string
): void {
  motionState.lastTarget = [...joints];
  motionState.history.push({
    timestamp: new Date().toISOString(),
    joints: [...joints],
    source,
  });
  const MAX_HISTORY = 200;
  if (motionState.history.length > MAX_HISTORY) {
    motionState.history.splice(0, motionState.history.length - MAX_HISTORY);
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
    case "wave":   setIf(0, 25); setIf(3, 18); setIf(5, -20); break;
    case "bounce": setIf(1, -22); setIf(2, 18); break;
    case "sway":   setIf(0, -20); setIf(4, 15); break;
    case "twist":  setIf(3, 28); setIf(5, 32); break;
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
  repeat: number; speed: number; maxJointStep: number; minSamples: number;
  interpolation: InterpolationMode; waypoints: number;
  start: number[]; end: number[]; moduleName: string;
}> {
  const { pointA, pointB, repeat, speed, maxJointStep, minSamples,
    interpolation, autoConnect, returnToA, moduleName, source } = options;

  let continuityFrom: number[] | null = null;
  if (autoConnect) {
    continuityFrom = motionState.lastTarget ? [...motionState.lastTarget] : null;
    if (!continuityFrom) continuityFrom = await controller.getJointPositions();
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

  if (waypoints.length === 0)
    throw new Error("No motion generated; points are identical and no continuity segment needed");

  const rapidPoints = waypoints.map((joints, idx) => ({
    joints, speed, zone: idx === waypoints.length - 1 ? "fine" : "z10",
  }));
  const rapidCode = controller.generateRapidSequence(rapidPoints, moduleName);
  await controller.executeRapidProgram(rapidCode, moduleName);
  pushHistory(motionState, cursor, source);

  return { repeat, speed, maxJointStep, minSamples, interpolation,
    waypoints: waypoints.length, start: pointA, end: cursor, moduleName };
}

function speedToRapidConst(speed: number): string {
  if (speed <= 10) return "v10";
  if (speed <= 20) return "v20";
  if (speed <= 50) return "v50";
  return "v100";
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

  if (action === "disconnect") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    try {
      await controller.disconnect();
      return { content: [{ type: "text" as const, text: "✓ Disconnected" }], details: { connected: false } };
    } catch (err) { return errorResult(`Disconnect failed: ${String(err)}`); }
  }

  if (action === "get_status") {
    if (!controller?.isConnected())
      return { content: [{ type: "text" as const, text: "Not connected" }], details: { connected: false } };
    try {
      const s = await controller.getStatus();
      return { content: [{ type: "text" as const, text:
        `Status:\n  Mode: ${s.operationMode}\n  Motors: ${s.motorState}\n  RAPID: ${s.rapidRunning} (${s.rapidExecutionStatus})` }],
        details: s };
    } catch (err) { return errorResult(`get_status failed: ${String(err)}`); }
  }

  if (action === "get_system_info") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    try {
      const info = await controller.getSystemInfo();
      return { content: [{ type: "text" as const, text:
        `System: ${info.systemName}\n  Controller: ${info.controllerName}\n  RobotWare: ${info.robotWareName} v${info.robotWareVersion}\n  Virtual: ${info.isVirtual}` }],
        details: info };
    } catch (err) { return errorResult(`get_system_info failed: ${String(err)}`); }
  }

  if (action === "get_service_info") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    try {
      const info = await controller.getServiceInfo();
      return { content: [{ type: "text" as const, text:
        `Service Info:\n  Production Hours: ${info.elapsedProductionHours}\n  Last Start: ${info.lastStart}` }],
        details: info };
    } catch (err) { return errorResult(`get_service_info failed: ${String(err)}`); }
  }

  if (action === "get_speed") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    try {
      const ratio = await controller.getSpeedRatio();
      return { content: [{ type: "text" as const, text: `Speed ratio: ${ratio}%` }], details: { speedRatio: ratio } };
    } catch (err) { return errorResult(`get_speed failed: ${String(err)}`); }
  }

  if (action === "set_speed") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    const speed = clamp(Number(params["speed"] ?? 100), 1, 100);
    try {
      const ratio = await controller.setSpeedRatio(speed);
      return { content: [{ type: "text" as const, text: `✓ Speed ratio set to ${ratio}%` }], details: { speedRatio: ratio } };
    } catch (err) { return errorResult(`set_speed failed: ${String(err)}`); }
  }

  if (action === "get_joints") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    try {
      const joints = await controller.getJointPositions();
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const lines = cfg.joints.map((j, i) => `  ${j.label ?? j.id}: ${(joints[i] ?? 0).toFixed(2)}\u00b0 [${j.min}\u2026${j.max}]`);
      return { content: [{ type: "text" as const, text: `Joint Positions:\n${lines.join("\n")}` }], details: { joints } };
    } catch (err) { return errorResult(`get_joints failed: ${String(err)}`); }
  }

  if (action === "get_world_position") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    try {
      const p = await controller.getWorldPosition();
      return { content: [{ type: "text" as const, text:
        `World Pos (mm/deg):\n  X:${p.x.toFixed(2)} Y:${p.y.toFixed(2)} Z:${p.z.toFixed(2)}\n  Rx:${p.rx.toFixed(2)} Ry:${p.ry.toFixed(2)} Rz:${p.rz.toFixed(2)}` }],
        details: p };
    } catch (err) { return errorResult(`get_world_position failed: ${String(err)}`); }
  }

  if (action === "get_event_log") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    const categoryId = Number(params["category_id"] ?? params["categoryId"] ?? 0);
    const limit = clamp(Number(params["limit"] ?? 20), 1, 200);
    try {
      const result = await controller.getEventLogEntries(categoryId, limit) as any;
      if (!result.success) return errorResult(String(result.error ?? "get_event_log failed"));
      const lines = (result.entries as any[]).map(
        (e) => `  [${e.type}] ${String(e.timestamp).slice(0, 19)} #${e.number}: ${e.title}`
      );
      return { content: [{ type: "text" as const, text: `Event Log (cat ${categoryId}):\n${lines.join("\n")}` }], details: result };
    } catch (err) { return errorResult(`get_event_log failed: ${String(err)}`); }
  }

  if (action === "list_tasks") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    try {
      const result = await controller.listTasks() as any;
      if (!result.success) return errorResult(String(result.error ?? "list_tasks failed"));
      const lines = (result.tasks as any[]).map(
        (t) => `  \u2022 ${t.taskName} [${t.executionStatus}] \u2014 ${t.modules.join(", ")}`
      );
      return { content: [{ type: "text" as const, text: `RAPID Tasks (${result.count}):\n${lines.join("\n")}` }], details: result };
    } catch (err) { return errorResult(`list_tasks failed: ${String(err)}`); }
  }

  if (action === "backup_module") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    const moduleName = String(params["module_name"] ?? params["moduleName"] ?? "");
    const taskName   = String(params["task_name"]   ?? params["taskName"]   ?? "");
    const outputDir  = String(params["output_dir"]  ?? params["outputDir"]  ?? ".");
    try {
      const result = await controller.backupModule(moduleName, taskName, outputDir) as any;
      if (!result.success) return errorResult(String(result.error ?? "backup_module failed"));
      return { content: [{ type: "text" as const, text: `\u2713 Backed up '${result.moduleName}' to ${result.outputDir}` }], details: result };
    } catch (err) { return errorResult(`backup_module failed: ${String(err)}`); }
  }

  if (action === "reset_program_pointer") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    const taskName   = String(params["task_name"]   ?? params["taskName"]   ?? "T_ROB1");
    const moduleName = params["module_name"] != null ? String(params["module_name"]) : undefined;
    const routineName = params["routine_name"] != null ? String(params["routine_name"]) : undefined;
    try {
      const r = await controller.resetProgramPointer(taskName, moduleName, routineName) as any;
      const method = r?.method ?? "ResetProgramPointer";
      const extra = r?.moduleName ? ` → ${r.moduleName}.${r.routineName}` : "";
      return { content: [{ type: "text" as const, text: `\u2713 Program pointer reset (${taskName})${extra} [${method}]` }], details: r ?? { taskName } };
    } catch (err) { return errorResult(`reset_program_pointer failed: ${String(err)}`); }
  }

  if (action === "set_joints") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    const rawJ = params["joints"];
    if (!Array.isArray(rawJ)) return errorResult("joints array is required");
    const nums = (rawJ as unknown[]).map(Number);
    if (nums.some(isNaN)) return errorResult("joints must all be numeric");
    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const { values, violations } = validateJointValues(cfg, nums);
      const speed = Number(params["speed"] ?? 100);
      await controller.moveToJoints(values, speed);
      const lines = cfg.joints.map((j, i) => `  ${j.label ?? j.id}: ${values[i]!.toFixed(2)}\u00b0`);
      let text = `\u2713 Moving to joints:\n${lines.join("\n")}`;
      if (violations.length) text += `\n\n\u26a0 Clamped:\n${violations.map(v => `  ${v}`).join("\n")}`;
      pushHistory(motionState, values, "set_joints");
      return { content: [{ type: "text" as const, text }], details: { joints: values, violations } };
    } catch (err) { return errorResult(`set_joints failed: ${String(err)}`); }
  }

  if (action === "movj") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    const rawTarget = params["joints"];
    if (!Array.isArray(rawTarget)) return errorResult("joints array is required");
    const targetNums = (rawTarget as unknown[]).map(Number);
    if (targetNums.some(isNaN)) return errorResult("joints must all be numeric");
    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const { values: target, violations: tViol } = validateJointValues(cfg, targetNums);
      const speed = clamp(Number(params["speed"] ?? 45), 1, 100);
      const maxJointStep = clamp(Number(params["max_joint_step"] ?? 6), 0.25, 45);
      const minSamples = clamp(Number(params["min_samples"] ?? 2), 2, 50);
      const iRaw = String(params["interpolation"] ?? "cosine").toLowerCase();
      const interpolation: InterpolationMode =
        iRaw === "linear" || iRaw === "smoothstep" || iRaw === "cosine" ? iRaw : "cosine";
      const moduleName = String(params["module_name"] ?? "MoveJSegment");
      const rawStart = params["start_joints"];
      let start: number[]; let sViol: string[] = [];
      if (Array.isArray(rawStart)) {
        const sNums = (rawStart as unknown[]).map(Number);
        if (sNums.some(isNaN)) return errorResult("start_joints must all be numeric");
        const sv = validateJointValues(cfg, sNums); start = sv.values; sViol = sv.violations;
      } else if (motionState.lastTarget && motionState.lastTarget.length === target.length) {
        start = [...motionState.lastTarget];
      } else {
        start = await controller.getJointPositions();
      }
      const wps = interpolateJoints(start, target, maxJointStep, minSamples, interpolation);
      const rapidCode = controller.generateRapidSequence(
        wps.map((joints, idx) => ({ joints, speed, zone: idx === wps.length - 1 ? "fine" : "z10" })),
        moduleName
      );
      await controller.executeRapidProgram(rapidCode, moduleName);
      pushHistory(motionState, target, "movj");
      const violations = [...sViol, ...tViol];
      let text = `\u2713 MoveJ  speed:${speed}  wpts:${wps.length}  interp:${interpolation}\n  End:[${target.map(v => v.toFixed(2)).join(",")}]`;
      if (violations.length) text += `\n\u26a0 Clamped:\n${violations.map(v => `  ${v}`).join("\n")}`;
      return { content: [{ type: "text" as const, text }], details: { speed, waypoints: wps.length, start, end: target, moduleName, violations } };
    } catch (err) { return errorResult(`movj failed: ${String(err)}`); }
  }

  if (action === "movj_rapid") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    const rawJ = params["joints"];
    if (!Array.isArray(rawJ)) return errorResult("joints array is required");
    const nums = (rawJ as unknown[]).map(Number);
    if (nums.some(isNaN)) return errorResult("joints must all be numeric");
    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const { values, violations } = validateJointValues(cfg, nums);
      const speed = clamp(Number(params["speed"] ?? 20), 1, 100);
      const zone = String(params["zone"] ?? "fine");
      const rapidCode = controller.generateRapidMoveJoints(values, speed, zone);
      await controller.executeRapidProgram(rapidCode, "OpenClawMotionMod", true);
      pushHistory(motionState, values, "movj_rapid");
      let text = `\u2713 movj_rapid  joints:[${values.map(v => v.toFixed(2)).join(",")}]  speed:${speedToRapidConst(speed)}  zone:${zone}`;
      if (violations.length) text += `\n\u26a0 Clamped:\n${violations.map(v => `  ${v}`).join("\n")}`;
      return { content: [{ type: "text" as const, text }], details: { joints: values, speed, zone, violations } };
    } catch (err) { return errorResult(`movj_rapid failed: ${String(err)}`); }
  }

  if (action === "go_home") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const homeJoints = cfg.joints.map(j => j.home);
      await controller.moveToJoints(homeJoints);
      pushHistory(motionState, homeJoints, "go_home");
      return { content: [{ type: "text" as const, text: "\u2713 Moving to home position" }], details: { joints: homeJoints } };
    } catch (err) { return errorResult(`go_home failed: ${String(err)}`); }
  }

  if (action === "set_preset") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    const presetName = String(params["preset"] ?? "").trim();
    if (!presetName) return errorResult("preset name is required");
    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const joints = resolvePreset(cfg, presetName);
      const speed = Number(params["speed"] ?? 100);
      await controller.moveToJoints(joints, speed);
      pushHistory(motionState, joints, `preset:${presetName}`);
      const lines = cfg.joints.map((j, i) => `  ${j.label ?? j.id}: ${joints[i]!.toFixed(2)}\u00b0`);
      return { content: [{ type: "text" as const, text: `\u2713 Preset "${presetName}":\n${lines.join("\n")}` }], details: { preset: presetName, joints } };
    } catch (err) { return errorResult(String(err)); }
  }

  if (action === "run_sequence") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    const seqName = String(params["sequence"] ?? "").trim();
    if (!seqName) return errorResult("sequence name is required");
    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const seq = resolveSequence(cfg, seqName);
      const positions = seq.steps.map(s => ({ joints: s.joints, speed: s.speed ?? 100, zone: s.zone ?? "z10" }));
      const rapidCode = controller.generateRapidSequence(positions);
      await controller.executeRapidProgram(rapidCode);
      if (seq.steps.length > 0) pushHistory(motionState, seq.steps[seq.steps.length - 1]!.joints, `seq:${seqName}`);
      return { content: [{ type: "text" as const, text: `\u2713 Sequence "${seqName}" (${seq.steps.length} steps)` }], details: { sequence: seqName, steps: seq.steps.length } };
    } catch (err) { return errorResult(String(err)); }
  }

  if (action === "list_robots") {
    const robots = listRobots();
    const lines = robots.map(r => { try { const c = getCfg(r); return `  \u2022 ${r} \u2014 ${c.manufacturer} ${c.model} (${c.dof} DOF)`; } catch { return `  \u2022 ${r}`; } });
    return { content: [{ type: "text" as const, text: `Robots:\n${lines.join("\n")}` }], details: { robots } };
  }

  if (action === "list_presets") {
    const robotId = String(params["robot_id"] ?? currentConfig?.id ?? "abb-crb-15000");
    try {
      const cfg = getCfg(robotId);
      const presets = Object.keys(cfg.presets ?? {});
      return { content: [{ type: "text" as const, text: presets.length ? `Presets for ${robotId}:\n${presets.map(p => `  \u2022 ${p}`).join("\n")}` : "No presets defined" }], details: { robotId, presets } };
    } catch (err) { return errorResult(String(err)); }
  }

  if (action === "list_sequences") {
    const robotId = String(params["robot_id"] ?? currentConfig?.id ?? "abb-crb-15000");
    try {
      const cfg = getCfg(robotId);
      const seqs = Object.entries(cfg.sequences ?? {}).map(([k, v]) => `  \u2022 ${k}${v.description ? ` \u2014 ${v.description}` : ""}`);
      return { content: [{ type: "text" as const, text: seqs.length ? `Sequences for ${robotId}:\n${seqs.join("\n")}` : "No sequences defined" }], details: { robotId, sequences: Object.keys(cfg.sequences ?? {}) } };
    } catch (err) { return errorResult(String(err)); }
  }

  if (action === "execute_rapid") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    const code = String(params["rapid_code"] ?? "");
    if (!code) return errorResult("rapid_code parameter is required");
    const moduleName = String(params["module_name"] ?? "OpenClawMotionMod");
    const allowReal = params["allow_real_execution"] !== false;
    try {
      await controller.executeRapidProgram(code, moduleName, allowReal);
      return { content: [{ type: "text" as const, text: `\u2713 RAPID executed (${moduleName})` }], details: { moduleName } };
    } catch (err) { return errorResult(`execute_rapid failed: ${String(err)}`); }
  }

  if (action === "load_rapid") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    const code = String(params["rapid_code"] ?? "");
    if (!code) return errorResult("rapid_code parameter is required");
    const allowReal = Boolean(params["allow_real_execution"] ?? false);
    try {
      await controller.loadRapidProgram(code, allowReal);
      return { content: [{ type: "text" as const, text: "\u2713 RAPID program loaded" }], details: { loaded: true } };
    } catch (err) { return errorResult(`load_rapid failed: ${String(err)}`); }
  }

  if (action === "start_program") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    const allowReal = Boolean(params["allow_real_execution"] ?? true);
    try {
      await controller.startRapid(allowReal);
      return { content: [{ type: "text" as const, text: "\u2713 RAPID program started" }], details: { running: true } };
    } catch (err) { return errorResult(`start_program failed: ${String(err)}`); }
  }

  if (action === "stop_program") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    try {
      await controller.stopRapid();
      return { content: [{ type: "text" as const, text: "\u2713 RAPID program stopped" }], details: { running: false } };
    } catch (err) { return errorResult(`stop_program failed: ${String(err)}`); }
  }

  if (action === "motors_on" || action === "motors_off") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    try {
      await controller.setMotors(action === "motors_on" ? "ON" : "OFF");
      return { content: [{ type: "text" as const, text: `\u2713 Motors ${action === "motors_on" ? "ON" : "OFF"}` }], details: { motorState: action === "motors_on" ? "ON" : "OFF" } };
    } catch (err) { return errorResult(`${action} failed: ${String(err)}`); }
  }

  if (action === "identify_robot") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    try {
      const { identifyRobot } = await import("./robot-config-loader.js");
      const liveJoints = await controller.getJointPositions();
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const jointCfgs = liveJoints.map((_, i) => ({ index: i, id: `joint${i}`, type: "revolute" as const, min: cfg.joints[i]?.min ?? -180, max: cfg.joints[i]?.max ?? 180, home: cfg.joints[i]?.home ?? 0 }));
      const id = identifyRobot(jointCfgs);
      if (id) {
        const ic = getCfg(id);
        return { content: [{ type: "text" as const, text: `\u2713 Identified: ${ic.manufacturer} ${ic.model} (${id})` }], details: { robotId: id, manufacturer: ic.manufacturer, model: ic.model } };
      }
      return { content: [{ type: "text" as const, text: `\u26a0 Could not identify robot (${liveJoints.length} DOF). Specify robot_id manually.` }], details: { identified: false } };
    } catch (err) { return errorResult(`identify_robot failed: ${String(err)}`); }
  }

  if (action === "get_motion_memory") {
    return { content: [{ type: "text" as const, text:
      `Motion memory:\n  Last: ${motionState.lastTarget ? `[${motionState.lastTarget.map(v => v.toFixed(2)).join(",")}]` : "(none)"}\n  History: ${motionState.history.length} entries` }],
      details: { lastTarget: motionState.lastTarget, historyCount: motionState.history.length, recent: motionState.history.slice(-10) } };
  }

  if (action === "reset_motion_memory") {
    motionState.lastTarget = null; motionState.history = [];
    return { content: [{ type: "text" as const, text: "\u2713 Motion memory reset" }], details: { reset: true } };
  }

  if (action === "dance_two_points") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    const rawA = params["point_a"]; const rawB = params["point_b"];
    if (!Array.isArray(rawA) || !Array.isArray(rawB)) return errorResult("point_a and point_b arrays are required");
    const pA = (rawA as unknown[]).map(Number); const pB = (rawB as unknown[]).map(Number);
    if (pA.some(isNaN) || pB.some(isNaN)) return errorResult("point_a and point_b must be numeric");
    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const { values: pointA, violations: vA } = validateJointValues(cfg, pA);
      const { values: pointB, violations: vB } = validateJointValues(cfg, pB);
      const repeat = clamp(Number(params["repeat"] ?? 2), 1, 64);
      const speed = clamp(Number(params["speed"] ?? 45), 1, 100);
      const maxJointStep = clamp(Number(params["max_joint_step"] ?? 6), 0.25, 45);
      const minSamples = clamp(Number(params["min_samples"] ?? 2), 2, 50);
      const iRaw = String(params["interpolation"] ?? "cosine").toLowerCase();
      const interpolation: InterpolationMode = iRaw === "linear" || iRaw === "smoothstep" || iRaw === "cosine" ? iRaw : "cosine";
      const result = await executeContinuousDance(controller, cfg, motionState, {
        pointA, pointB, repeat, speed, maxJointStep, minSamples, interpolation,
        autoConnect: params["auto_connect"] !== false, returnToA: params["return_to_a"] === true,
        moduleName: String(params["module_name"] ?? "DanceSegment"), source: "dance_two_points",
      });
      const violations = [...vA, ...vB];
      let text = `\u2713 Dance  repeat:${result.repeat}  wpts:${result.waypoints}  speed:${result.speed}  interp:${result.interpolation}`;
      if (violations.length) text += `\n\u26a0 Clamped:\n${violations.map(v => `  ${v}`).join("\n")}`;
      return { content: [{ type: "text" as const, text }], details: { ...result, violations } };
    } catch (err) { return errorResult(`dance_two_points failed: ${String(err)}`); }
  }

  if (action === "dance_template") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    try {
      const cfg = currentConfig || getCfg("abb-crb-15000");
      const template = String(params["template"] ?? "wave").toLowerCase();
      const amplitude = clamp(Number(params["amplitude"] ?? 1.0), 0.1, 2.0);
      const beats = clamp(Number(params["beats"] ?? 8), 2, 64);
      const speed = clamp(Number(params["speed"] ?? 45), 1, 100);
      const maxJointStep = clamp(Number(params["max_joint_step"] ?? 6), 0.25, 45);
      const minSamples = clamp(Number(params["min_samples"] ?? 2), 2, 50);
      const iRaw = String(params["interpolation"] ?? "cosine").toLowerCase();
      const interpolation: InterpolationMode = iRaw === "linear" || iRaw === "smoothstep" || iRaw === "cosine" ? iRaw : "cosine";
      const { pointA, pointB } = buildTemplatePoints(cfg, template, amplitude);
      const repeat = Math.max(1, Math.floor(beats / 2));
      const result = await executeContinuousDance(controller, cfg, motionState, {
        pointA, pointB, repeat, speed, maxJointStep, minSamples, interpolation,
        autoConnect: params["auto_connect"] !== false, returnToA: params["return_to_a"] === true,
        moduleName: String(params["module_name"] ?? `DanceTemplate_${template}`), source: `dance_template:${template}`,
      });
      return { content: [{ type: "text" as const, text:
        `\u2713 Dance template '${template}'  beats:${beats}  repeat:${result.repeat}  wpts:${result.waypoints}` }],
        details: { template, amplitude, beats, ...result } };
    } catch (err) { return errorResult(`dance_template failed: ${String(err)}`); }
  }


  if (action === "get_event_log_categories") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    try {
      const result = await controller.getEventLogCategories() as any;
      if (!result.success) return errorResult(String(result.error ?? "get_event_log_categories failed"));
      const lines = (result.categories as any[]).map(
        (c: any) => `  cat[${c.categoryId}] ${c.name}: ${c.count} entries`
      );
      return { content: [{ type: "text" as const, text: `Event Log Categories:
${lines.join("\n")}` }], details: result };
    } catch (err) { return errorResult(`get_event_log_categories failed: ${String(err)}`); }
  }

  if (action === "get_rapid_variable") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    const taskName  = String(params["task_name"]   ?? params["taskName"]   ?? "T_ROB1");
    const varName   = String(params["var_name"]    ?? params["varName"]    ?? "");
    const moduleName = String(params["module_name"] ?? params["moduleName"] ?? "");
    if (!varName) return errorResult("var_name is required");
    try {
      const result = await controller.getRapidVariable(taskName, varName, moduleName) as any;
      if (!result.success) return errorResult(String(result.error ?? "get_rapid_variable failed"));
      return { content: [{ type: "text" as const, text: `${result.varName} (${result.dataType}) = ${result.value}` }], details: result };
    } catch (err) { return errorResult(`get_rapid_variable failed: ${String(err)}`); }
  }

  if (action === "get_io_signals") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    const nameFilter = String(params["name_filter"] ?? params["nameFilter"] ?? "");
    const limit = Math.max(1, Math.min(500, Number(params["limit"] ?? 100)));
    try {
      const result = await controller.getIOSignals(nameFilter, limit) as any;
      if (!result.success) return errorResult(String(result.error ?? "get_io_signals failed"));
      const lines = (result.signals as any[]).map(
        (s: any) => `  [${s.type}] ${s.name} = ${s.value}${s.unit ? " " + s.unit : ""}`
      );
      return { content: [{ type: "text" as const, text: `IO Signals (${result.count}):
${lines.join("\n")}` }], details: result };
    } catch (err) { return errorResult(`get_io_signals failed: ${String(err)}`); }
  }

  if (action === "list_rapid_variables") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    const taskName   = String(params["task_name"]   ?? params["taskName"]   ?? "T_ROB1");
    const moduleName = String(params["module_name"] ?? params["moduleName"] ?? "");
    const limit = Math.max(1, Math.min(200, Number(params["limit"] ?? 50)));
    try {
      const result = await controller.listRapidVariables(taskName, moduleName, limit) as any;
      if (!result.success) return errorResult(String(result.error ?? "list_rapid_variables failed"));
      const lines = (result.variables as any[]).map((v: any) => `  • ${v.name} [${v.rapidType ?? "?"}] = ${v.value ?? "?"} (${v.moduleName ?? taskName})`);
      return { content: [{ type: "text" as const, text: `RAPID Variables (${result.count}):\n${lines.join("\n")}` }], details: result };
    } catch (err) { return errorResult(`list_rapid_variables failed: ${String(err)}`); }
  }

  if (action === "movl") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    const x = Number(params["x"]);
    const y = Number(params["y"]);
    const z = Number(params["z"]);
    const rx = Number(params["rx"]);
    const ry = Number(params["ry"]);
    const rz = Number(params["rz"]);
    if (isNaN(x) || isNaN(y) || isNaN(z) || isNaN(rx) || isNaN(ry) || isNaN(rz)) {
      return errorResult("x, y, z, rx, ry, rz are required for movl");
    }
    const speed = clamp(Number(params["speed"] ?? 100), 1, 7000);
    const zone = String(params["zone"] ?? "fine");
    try {
      await controller.moveLinear(x, y, z, rx, ry, rz, speed, zone);
      return { content: [{ type: "text" as const, text: `\u2713 movl to [${x},${y},${z}] at speed ${speed}` }], details: { x, y, z, rx, ry, rz, speed, zone } };
    } catch (err) { return errorResult(`movl failed: ${String(err)}`); }
  }

  if (action === "movc") {
    if (!controller?.isConnected()) return errorResult("Not connected. Use 'connect' first.");
    const rCirc = params["circ_point"];
    const rTo = params["to_point"];
    if (!Array.isArray(rCirc) || !Array.isArray(rTo) || rCirc.length < 6 || rTo.length < 6) {
      return errorResult("circ_point and to_point must be arrays of at least 6 numbers [x,y,z,rx,ry,rz]");
    }
    const circPoint = (rCirc as unknown[]).map(Number);
    const toPoint = (rTo as unknown[]).map(Number);
    if (circPoint.some(isNaN) || toPoint.some(isNaN)) return errorResult("circ_point and to_point must be numeric");
    
    const speed = clamp(Number(params["speed"] ?? 100), 1, 7000);
    const zone = String(params["zone"] ?? "fine");
    try {
      await controller.moveCircular(circPoint, toPoint, speed, zone);
      return { content: [{ type: "text" as const, text: `\u2713 movc through [${circPoint.slice(0,3).join(",")}] to [${toPoint.slice(0,3).join(",")}] at speed ${speed}` }], details: { circPoint, toPoint, speed, zone } };
    } catch (err) { return errorResult(`movc failed: ${String(err)}`); }
  }

  if (action === "set_rapid_variable") {
    if (!controller?.isConnected()) return errorResult("Not connected");
    const taskName   = String(params["task_name"]   ?? params["taskName"]   ?? "T_ROB1");
    const moduleName = String(params["module_name"] ?? params["moduleName"] ?? "");
    const varName    = String(params["var_name"]    ?? params["varName"]    ?? "");
    const value      = String(params["value"]       ?? "");
    if (!varName || !value) return errorResult("var_name and value are required");
    try {
      const result = await controller.setRapidVariable(taskName, moduleName, varName, value) as any;
      if (!result.success) return errorResult(String(result.error ?? "set_rapid_variable failed"));
      return { content: [{ type: "text" as const, text: `\u2713 Set ${result.varName} = ${result.value}` }], details: result };
    } catch (err) { return errorResult(`set_rapid_variable failed: ${String(err)}`); }
  }

  return errorResult(`Unknown action: "${action}"`);
} 