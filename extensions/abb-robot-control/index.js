var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) =>
  function __init() {
    return (fn && (res = (0, fn[__getOwnPropNames(fn)[0]])((fn = 0))), res);
  };
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};

// src/robot-config-loader.ts
var robot_config_loader_exports = {};
__export(robot_config_loader_exports, {
  clampJoint: () => clampJoint,
  identifyRobot: () => identifyRobot,
  listRobots: () => listRobots,
  loadRobotConfig: () => loadRobotConfig,
  resolvePreset: () => resolvePreset,
  resolveSequence: () => resolveSequence,
  validateJointValues: () => validateJointValues,
});
import fs from "node:fs";
import path2 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function listRobots() {
  try {
    if (!fs.existsSync(ROBOTS_DIR)) {
      return [];
    }
    return fs
      .readdirSync(ROBOTS_DIR)
      .filter((f) => f.endsWith(".json") && !f.startsWith("robot-config"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
function loadRobotConfig(robotId) {
  const safeName = path2.basename(robotId);
  const filePath = path2.join(ROBOTS_DIR, `${safeName}.json`);
  if (!fs.existsSync(filePath)) {
    const available = listRobots();
    throw new Error(
      `Robot config not found: "${robotId}". Available: ${available.join(", ") || "(none)"}`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse robot config "${robotId}": ${String(err)}`);
  }
  return validateConfig(raw, robotId);
}
function identifyRobot(joints, dhParams) {
  const configs = listRobots();
  for (const configId of configs) {
    try {
      const config = loadRobotConfig(configId);
      if (config.dof !== joints.length) continue;
      let limitsMatch = true;
      for (let i = 0; i < joints.length; i++) {
        const configJoint = config.joints[i];
        const testJoint = joints[i];
        if (
          Math.abs(configJoint.min - testJoint.min) > 1 ||
          Math.abs(configJoint.max - testJoint.max) > 1
        ) {
          limitsMatch = false;
          break;
        }
      }
      if (!limitsMatch) continue;
      if (dhParams && config.dhParameters) {
        let dhMatch = true;
        for (let i = 0; i < dhParams.length; i++) {
          const configDH = config.dhParameters[i];
          const testDH = dhParams[i];
          if (
            Math.abs(configDH.d - testDH.d) > 0.01 ||
            Math.abs(configDH.a - testDH.a) > 0.01 ||
            Math.abs(configDH.alpha - testDH.alpha) > 0.01
          ) {
            dhMatch = false;
            break;
          }
        }
        if (!dhMatch) continue;
      }
      return configId;
    } catch {
      continue;
    }
  }
  return null;
}
function clampJoint(cfg, value) {
  return Math.max(cfg.min, Math.min(cfg.max, value));
}
function validateJointValues(config, values) {
  const violations = [];
  const sanitised = config.joints.map((joint, i) => {
    const raw = values[i] ?? joint.home;
    if (raw < joint.min || raw > joint.max) {
      violations.push(
        `${joint.label ?? joint.id}: ${raw.toFixed(2)} out of range [${joint.min}, ${joint.max}]`,
      );
    }
    return clampJoint(joint, raw);
  });
  return { values: sanitised, violations };
}
function resolvePreset(config, presetName) {
  const presets = config.presets ?? {};
  if (!(presetName in presets)) {
    throw new Error(
      `Unknown preset "${presetName}" for robot "${config.id}". Available: ${Object.keys(presets).join(", ") || "(none)"}`,
    );
  }
  const { values } = validateJointValues(config, presets[presetName]);
  return values;
}
function resolveSequence(config, sequenceName) {
  const sequences = config.sequences ?? {};
  if (!(sequenceName in sequences)) {
    throw new Error(
      `Unknown sequence "${sequenceName}" for robot "${config.id}". Available: ${Object.keys(sequences).join(", ") || "(none)"}`,
    );
  }
  const seq = sequences[sequenceName];
  return {
    ...seq,
    steps: seq.steps.map((step) => ({
      ...step,
      joints: validateJointValues(config, step.joints).values,
    })),
  };
}
function validateConfig(raw, id) {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Robot config "${id}" is not a valid JSON object`);
  }
  const obj = raw;
  if (!Array.isArray(obj["joints"]) || obj["joints"].length === 0) {
    throw new Error(`Robot config "${id}" must have a non-empty joints array`);
  }
  const joints = obj["joints"];
  for (const j of joints) {
    if (typeof j.min !== "number" || typeof j.max !== "number") {
      throw new Error(`Robot config "${id}": joint "${j.id}" missing numeric min/max`);
    }
    if (j.min > j.max) {
      throw new Error(`Robot config "${id}": joint "${j.id}" min (${j.min}) > max (${j.max})`);
    }
  }
  return obj;
}
var __dirname2, ROBOTS_DIR;
var init_robot_config_loader = __esm({
  "src/robot-config-loader.ts"() {
    "use strict";
    __dirname2 = path2.dirname(fileURLToPath2(import.meta.url));
    const ROBOTS_DIR_CANDIDATES = [
      path2.resolve(__dirname2, "../robots"),
      path2.resolve(__dirname2, "./robots"),
    ];
    ROBOTS_DIR =
      ROBOTS_DIR_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ??
      ROBOTS_DIR_CANDIDATES[0];
  },
});

// src/abb-controller.ts
import { EventEmitter as EventEmitter2 } from "node:events";
import { EventEmitter } from "node:events";
import fs2 from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// src/abb-csharp-bridge.ts
import * as edge from "edge-js";
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var ABBCSharpBridge = class extends EventEmitter {
  constructor() {
    super();
    this._connected = false;
    this._systemName = "";
    // edge-js function handles (initialised lazily)
    this.fn = {};
    this._initBridge();
  }
  // ── Init ─────────────────────────────────────────────────────────────────────────────
  _initBridge() {
    const dllCandidates = [
      path.join(__dirname, "ABBBridge.dll"),
      path.join(__dirname, "src", "ABBBridge.dll"),
    ];
    const dllPath =
      dllCandidates.find((candidate) => fs2.existsSync(candidate)) ?? dllCandidates[0];
    const methods = [
      "Connect",
      "Disconnect",
      "ScanControllers",
      "GetStatus",
      "GetSystemInfo",
      "GetServiceInfo",
      "GetSpeedRatio",
      "SetSpeedRatio",
      "GetJointPositions",
      "GetWorldPosition",
      "GetEventLogEntries",
      "ListTasks",
      "BackupModule",
      "LoadRapidProgram",
      "StartRapid",
      "StopRapid",
      "ResetProgramPointer",
      "MoveToJoints",
      "ExecuteRapidProgram",
      "SetMotors",
      "GetRapidVariable",
      "GetIOSignals",
      "GetEventLogCategories",
      "ListRapidVariables",
      "MoveLinear",
      "MoveCircular",
      "SetRapidVariable",
    ];
    for (const methodName of methods) {
      try {
        this.fn[methodName] = edge.func({
          assemblyFile: dllPath,
          typeName: "ABBBridge",
          methodName,
        });
      } catch {}
    }
  }
  _call(methodName, payload) {
    const fn = this.fn[methodName];
    if (!fn)
      return Promise.reject(
        new Error(
          `C# bridge method '${methodName}' not initialised \u2014 is ABBBridge.dll present?`,
        ),
      );
    return new Promise((resolve, reject) => {
      fn(payload, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }
  // ── Connection ─────────────────────────────────────────────────────────────────────
  async connect(host) {
    const result = await this._call("Connect", { host });
    if (result.success) {
      this._connected = true;
      this._systemName = String(result.systemName ?? "");
      this.emit("connected", result);
    }
    return result;
  }
  async disconnect() {
    const result = await this._call("Disconnect", {});
    if (result.success) {
      this._connected = false;
      this.emit("disconnected");
    }
    return result;
  }
  // ── Discovery ────────────────────────────────────────────────────────────────────
  async scanControllers() {
    return this._call("ScanControllers", {});
  }
  // ── Status & Info ──────────────────────────────────────────────────────────────────
  async getStatus() {
    return this._call("GetStatus", {});
  }
  async getSystemInfo() {
    return this._call("GetSystemInfo", {});
  }
  async getServiceInfo() {
    return this._call("GetServiceInfo", {});
  }
  // ── Speed ──────────────────────────────────────────────────────────────────────────
  async getSpeedRatio() {
    return this._call("GetSpeedRatio", {});
  }
  async setSpeedRatio(speed) {
    return this._call("SetSpeedRatio", { speed });
  }
  // ── Position ───────────────────────────────────────────────────────────────────────
  async getJointPositions() {
    const result = await this._call("GetJointPositions", {});
    if (!result.success) throw new Error(String(result.error ?? "GetJointPositions failed"));
    return result.joints;
  }
  async getWorldPosition() {
    return this._call("GetWorldPosition", {});
  }
  // ── Event Log ──────────────────────────────────────────────────────────────────────
  async getEventLogEntries(categoryId = 0, limit = 20) {
    return this._call("GetEventLogEntries", { categoryId, limit });
  }
  // ── Tasks & Modules ──────────────────────────────────────────────────────────────────
  async listTasks() {
    return this._call("ListTasks", {});
  }
  async backupModule(moduleName, taskName, outputDir) {
    return this._call("BackupModule", { moduleName, taskName, outputDir });
  }
  async resetProgramPointer(taskName = "T_ROB1", moduleName, routineName) {
    return this._call("ResetProgramPointer", { taskName, moduleName, routineName });
  }
  // ── RAPID ─────────────────────────────────────────────────────────────────────────────
  async loadRapidProgram(code, allowRealExecution = false) {
    return this._call("LoadRapidProgram", { code, allowRealExecution });
  }
  async startRapid(allowRealExecution = true) {
    return this._call("StartRapid", { allowRealExecution });
  }
  async stopRapid() {
    return this._call("StopRapid", {});
  }
  // ── Motion ───────────────────────────────────────────────────────────────────────────
  async moveToJoints(joints, speed = 100, zone = "fine") {
    return this._call("MoveToJoints", { joints, speed, zone });
  }
  async moveLinear(x, y, z, rx, ry, rz, speed = 100, zone = "fine") {
    return this._call("MoveLinear", { x, y, z, rx, ry, rz, speed, zone });
  }
  async moveCircular(circPoint, toPoint, speed = 100, zone = "fine") {
    return this._call("MoveCircular", { circPoint, toPoint, speed, zone });
  }
  /**
   * High-level: load + reset pointer + start + wait for completion.
   * Maps to C# ExecuteRapidProgram which calls ExecuteRapidProgramWait internally.
   */
  async executeRapidProgram(code, moduleName = "OpenClawMotionMod", allowRealExecution = true) {
    return this._call("ExecuteRapidProgram", { code, moduleName, allowRealExecution });
  }
  /**
   * Set motors ON or OFF.
   * Note: may fail on real controllers with DefaultUser credentials.
   */
  async setMotors(state) {
    return this._call("SetMotors", { state });
  }
  // ── IO & RAPID Variables ──────────────────────────────────────────────────────────────────────
  async getEventLogCategories() {
    return this._call("GetEventLogCategories", {});
  }
  async getRapidVariable(taskName, varName, moduleName = "") {
    return this._call("GetRapidVariable", { taskName, varName, moduleName });
  }
  async setRapidVariable(taskName, moduleName, varName, value) {
    return this._call("SetRapidVariable", { taskName, moduleName, varName, value });
  }
  async getIOSignals(nameFilter = "", limit = 100) {
    return this._call("GetIOSignals", { nameFilter, limit });
  }
  async listRapidVariables(taskName = "T_ROB1", moduleName = "", limit = 50) {
    return this._call("ListRapidVariables", { taskName, moduleName, limit });
  }
  // ── Helpers ──────────────────────────────────────────────────────────────────────────
  isConnected() {
    return this._connected;
  }
  getSystemName() {
    return this._systemName;
  }
};

// src/abb-controller.ts
var ABBController = class extends EventEmitter2 {
  constructor(config) {
    super();
    this._connected = false;
    this._systemName = "";
    this.config = { port: 7e3, ...config };
    this.bridge = new ABBCSharpBridge();
  }
  // ── Connection ─────────────────────────────────────────────────────────────
  async connect() {
    if (this._connected) throw new Error("Already connected to controller");
    const result = await this.bridge.connect(this.config.host);
    if (!result.success) throw new Error(result.error ?? "Failed to connect to controller");
    this._connected = true;
    this._systemName = String(result.systemName ?? "");
    this.emit("connected", { systemName: this._systemName });
  }
  async disconnect() {
    if (!this._connected) return;
    try {
      await this.bridge.disconnect();
    } finally {
      this._connected = false;
      this.emit("disconnected");
    }
  }
  // ── Discovery ──────────────────────────────────────────────────────────────
  /** Scan for ABB controllers on the network. Does NOT require connect(). */
  async scanControllers() {
    const r = await this.bridge.scanControllers();
    return r;
  }
  // ── Status & Info ──────────────────────────────────────────────────────────
  async getStatus() {
    if (!this._connected) return { connected: false };
    const r = await this.bridge.getStatus();
    return {
      connected: true,
      operationMode: String(r.operationMode ?? ""),
      motorState: String(r.motorState ?? ""),
      rapidRunning: Boolean(r.rapidRunning),
      rapidExecutionStatus: String(r.rapidExecutionStatus ?? ""),
      systemName: this._systemName,
    };
  }
  async getSystemInfo() {
    this._ensureConnected();
    return this.bridge.getSystemInfo();
  }
  async getServiceInfo() {
    this._ensureConnected();
    return this.bridge.getServiceInfo();
  }
  // ── Speed ──────────────────────────────────────────────────────────────────
  async getSpeedRatio() {
    this._ensureConnected();
    const r = await this.bridge.getSpeedRatio();
    if (!r.success) throw new Error(String(r.error ?? "getSpeedRatio failed"));
    return Number(r.speedRatio);
  }
  async setSpeedRatio(speed) {
    this._ensureConnected();
    const r = await this.bridge.setSpeedRatio(speed);
    if (!r.success) throw new Error(String(r.error ?? "setSpeedRatio failed"));
    return Number(r.speedRatio);
  }
  // ── Position ───────────────────────────────────────────────────────────────
  async getJointPositions() {
    this._ensureConnected();
    return this.bridge.getJointPositions();
  }
  async getWorldPosition() {
    this._ensureConnected();
    const r = await this.bridge.getWorldPosition();
    if (!r.success) throw new Error(String(r.error ?? "getWorldPosition failed"));
    return {
      x: Number(r.x),
      y: Number(r.y),
      z: Number(r.z),
      rx: Number(r.rx),
      ry: Number(r.ry),
      rz: Number(r.rz),
    };
  }
  // ── Event Log ──────────────────────────────────────────────────────────────
  async getEventLogEntries(categoryId = 0, limit = 20) {
    this._ensureConnected();
    return this.bridge.getEventLogEntries(categoryId, limit);
  }
  // ── Tasks & Modules ────────────────────────────────────────────────────────
  async listTasks() {
    this._ensureConnected();
    return this.bridge.listTasks();
  }
  async backupModule(moduleName = "", taskName = "", outputDir = ".") {
    this._ensureConnected();
    return this.bridge.backupModule(moduleName, taskName, outputDir);
  }
  async resetProgramPointer(taskName = "T_ROB1", moduleName, routineName) {
    this._ensureConnected();
    const r = await this.bridge.resetProgramPointer(taskName, moduleName, routineName);
    if (!r.success) throw new Error(String(r.error ?? "resetProgramPointer failed"));
    return r;
  }
  // ── RAPID ──────────────────────────────────────────────────────────────────
  /** Load RAPID code to the controller without starting execution. */
  async loadRapidProgram(code, allowRealExecution = false) {
    this._ensureConnected();
    const r = await this.bridge.loadRapidProgram(code, allowRealExecution);
    if (!r.success) throw new Error(String(r.error ?? "loadRapidProgram failed"));
  }
  /** Start previously loaded RAPID program. */
  async startRapid(allowRealExecution = true) {
    this._ensureConnected();
    const r = await this.bridge.startRapid(allowRealExecution);
    if (!r.success) throw new Error(String(r.error ?? "startRapid failed"));
  }
  /** Stop currently running RAPID program. */
  async stopRapid() {
    this._ensureConnected();
    const r = await this.bridge.stopRapid();
    if (!r.success) throw new Error(String(r.error ?? "stopRapid failed"));
  }
  /**
   * Execute a RAPID program end-to-end via C# ExecuteRapidProgram
   * (load → reset pointer → start → event-driven wait for completion).
   */
  async executeRapidProgram(code, moduleName = "OpenClawMotionMod", allowRealExecution = true) {
    this._ensureConnected();
    const r = await this.bridge.executeRapidProgram(code, moduleName, allowRealExecution);
    if (!r.success) throw new Error(String(r.error ?? "executeRapidProgram failed"));
  }
  // ── Motion ─────────────────────────────────────────────────────────────────
  /**
   * Move robot to absolute joint positions.
   * Internally uses ABBBridge.MoveToJoints which generates and executes RAPID.
   */
  async moveToJoints(joints, speed = 100, zone = "fine") {
    this._ensureConnected();
    const r = await this.bridge.moveToJoints(joints, speed, zone);
    if (!r.success) throw new Error(String(r.error ?? "moveToJoints failed"));
  }
  /** Move linearly (Cartesian) to the specified XYZ/Euler target. */
  async moveLinear(x, y, z, rx, ry, rz, speed = 100, zone = "fine") {
    this._ensureConnected();
    const r = await this.bridge.moveLinear(x, y, z, rx, ry, rz, speed, zone);
    if (!r.success) throw new Error(String(r.error ?? "moveLinear failed"));
  }
  /** Move circularly from current pos through circPoint to toPoint (XYZ/Euler). */
  async moveCircular(circPoint, toPoint, speed = 100, zone = "fine") {
    this._ensureConnected();
    const r = await this.bridge.moveCircular(circPoint, toPoint, speed, zone);
    if (!r.success) throw new Error(String(r.error ?? "moveCircular failed"));
  }
  /** Set motors ON or OFF. Requires appropriate user grant on real controllers. */
  async setMotors(state) {
    this._ensureConnected();
    const r = await this.bridge.setMotors(state);
    if (!r.success) throw new Error(String(r.error ?? "setMotors failed"));
  }
  /** Get event log category summaries (categories 0-5). */
  async getEventLogCategories() {
    this._ensureConnected();
    return this.bridge.getEventLogCategories();
  }
  /** Read a RAPID variable value from a task/module. */
  async getRapidVariable(taskName, varName, moduleName = "") {
    this._ensureConnected();
    return this.bridge.getRapidVariable(taskName, varName, moduleName);
  }
  /** Write a RAPID variable value to a task/module. */
  async setRapidVariable(taskName, moduleName, varName, value) {
    this._ensureConnected();
    return this.bridge.setRapidVariable(taskName, moduleName, varName, value);
  }
  /** List IO signals from the controller IOSystem. */
  async getIOSignals(nameFilter = "", limit = 100) {
    this._ensureConnected();
    return this.bridge.getIOSignals(nameFilter, limit);
  }
  /** List RAPID module names in a task. */
  async listRapidVariables(taskName = "T_ROB1", moduleName = "", limit = 50) {
    this._ensureConnected();
    return this.bridge.listRapidVariables(taskName, moduleName, limit);
  }
  // ── RAPID code generation helpers ─────────────────────────────────────────
  /**
   * Generate a RAPID MODULE containing a single MoveAbsJ to the given joints.
   * Speed is expressed as a speeddata literal to avoid invalid predefined names.
   */
  generateRapidMoveJoints(joints, speed = 100, zone = "fine") {
    const jointsStr = joints.map((j) => j.toFixed(4)).join(", ");
    const speedData = this._formatSpeedData(speed);
    return [
      "MODULE OpenClawMotionMod",
      "  PROC AgentMoveProc()",
      "    ConfJ \\Off;",
      "    ConfL \\Off;",
      `    VAR jointtarget jt := [[${jointsStr}],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];`,
      `    MoveAbsJ jt, ${speedData}, ${zone}, tool0;`,
      "    Stop;",
      "  ENDPROC",
      "ENDMODULE",
    ].join("\r\n");
  }
  /**
   * Generate a RAPID MODULE for a sequence of MoveAbsJ moves.
   * All intermediate points use z10; the final point uses fine.
   */
  generateRapidSequence(positions, moduleName = "OpenClawMotionMod") {
    const declarations = [];
    const moves = ["    ConfJ \\Off;", "    ConfL \\Off;"];
    positions.forEach((pos, i) => {
      const jointsStr = pos.joints.map((j) => j.toFixed(4)).join(", ");
      const speed = pos.speed ?? 100;
      const zone = pos.zone ?? (i === positions.length - 1 ? "fine" : "z10");
      declarations.push(
        `    VAR jointtarget p${i} := [[${jointsStr}],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];`,
      );
      moves.push(`    MoveAbsJ p${i}, ${this._formatSpeedData(speed)}, ${zone}, tool0;`);
    });
    moves.push("    Stop;");
    return [
      `MODULE ${moduleName}`,
      "  PROC AgentMoveProc()",
      ...declarations,
      ...moves,
      "  ENDPROC",
      "ENDMODULE",
    ].join("\r\n");
  }
  // ── Internals ─────────────────────────────────────────────────────────────
  isConnected() {
    return this._connected;
  }
  getSystemName() {
    return this._systemName;
  }
  _ensureConnected() {
    if (!this._connected) {
      throw new Error("Not connected to controller. Call connect() first.");
    }
  }
  _formatSpeedData(speed) {
    const tcp = Math.max(1, Math.min(7e3, Number(speed) || 100));
    return `[${tcp.toFixed(3).replace(/\.?0+$/, "")},500,5000,1000]`;
  }
};
function createController(config) {
  return new ABBController(config);
}

// src/abb-robot-tool-actions.ts
init_robot_config_loader();
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function equalJoints(a, b, epsilon = 1e-3) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > epsilon) return false;
  }
  return true;
}
function interpolateJoints(from, to, maxJointStep, minSamples = 2, mode = "cosine") {
  const safeStep = Math.max(0.25, maxJointStep);
  let maxDelta = 0;
  for (let i = 0; i < to.length; i++) {
    maxDelta = Math.max(maxDelta, Math.abs((to[i] ?? 0) - (from[i] ?? 0)));
  }
  const samples = Math.max(minSamples, Math.ceil(maxDelta / safeStep));
  const out = [];
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
      }),
    );
  }
  return out;
}
function pushHistory(motionState2, joints, source) {
  motionState2.lastTarget = [...joints];
  motionState2.history.push({
    timestamp: /* @__PURE__ */ new Date().toISOString(),
    joints: [...joints],
    source,
  });
  const MAX_HISTORY = 200;
  if (motionState2.history.length > MAX_HISTORY) {
    motionState2.history.splice(0, motionState2.history.length - MAX_HISTORY);
  }
}
function buildTemplatePoints(cfg, template, amplitude) {
  const home = cfg.joints.map((j) => j.home);
  const a = [...home];
  const b = [...home];
  const amp = clamp(amplitude, 0.1, 2);
  const setIf = (idx, delta) => {
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
async function executeContinuousDance(controller2, cfg, motionState2, options) {
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
  let continuityFrom = null;
  if (autoConnect) {
    continuityFrom = motionState2.lastTarget ? [...motionState2.lastTarget] : null;
    if (!continuityFrom) continuityFrom = await controller2.getJointPositions();
  }
  const waypoints = [];
  let cursor = pointA;
  if (continuityFrom && !equalJoints(continuityFrom, pointA)) {
    waypoints.push(
      ...interpolateJoints(continuityFrom, pointA, maxJointStep, minSamples, interpolation),
    );
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
    joints,
    speed,
    zone: idx === waypoints.length - 1 ? "fine" : "z10",
  }));
  const rapidCode = controller2.generateRapidSequence(rapidPoints, moduleName);
  await controller2.executeRapidProgram(rapidCode, moduleName);
  pushHistory(motionState2, cursor, source);
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
function speedToRapidConst(speed) {
  if (speed <= 10) return "v10";
  if (speed <= 20) return "v20";
  if (speed <= 50) return "v50";
  return "v100";
}
async function handleAction(
  action,
  params,
  controller2,
  currentConfig2,
  pluginConfig,
  getCfg2,
  errorResult2,
  motionState2,
) {
  if (action === "disconnect") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    try {
      await controller2.disconnect();
      return {
        content: [{ type: "text", text: "\u2713 Disconnected" }],
        details: { connected: false },
      };
    } catch (err) {
      return errorResult2(`Disconnect failed: ${String(err)}`);
    }
  }
  if (action === "get_status") {
    if (!controller2?.isConnected())
      return { content: [{ type: "text", text: "Not connected" }], details: { connected: false } };
    try {
      const s = await controller2.getStatus();
      return {
        content: [
          {
            type: "text",
            text: `Status:
  Mode: ${s.operationMode}
  Motors: ${s.motorState}
  RAPID: ${s.rapidRunning} (${s.rapidExecutionStatus})`,
          },
        ],
        details: s,
      };
    } catch (err) {
      return errorResult2(`get_status failed: ${String(err)}`);
    }
  }
  if (action === "get_system_info") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    try {
      const info = await controller2.getSystemInfo();
      return {
        content: [
          {
            type: "text",
            text: `System: ${info.systemName}
  Controller: ${info.controllerName}
  RobotWare: ${info.robotWareName} v${info.robotWareVersion}
  Virtual: ${info.isVirtual}`,
          },
        ],
        details: info,
      };
    } catch (err) {
      return errorResult2(`get_system_info failed: ${String(err)}`);
    }
  }
  if (action === "get_service_info") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    try {
      const info = await controller2.getServiceInfo();
      return {
        content: [
          {
            type: "text",
            text: `Service Info:
  Production Hours: ${info.elapsedProductionHours}
  Last Start: ${info.lastStart}`,
          },
        ],
        details: info,
      };
    } catch (err) {
      return errorResult2(`get_service_info failed: ${String(err)}`);
    }
  }
  if (action === "get_speed") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    try {
      const ratio = await controller2.getSpeedRatio();
      return {
        content: [{ type: "text", text: `Speed ratio: ${ratio}%` }],
        details: { speedRatio: ratio },
      };
    } catch (err) {
      return errorResult2(`get_speed failed: ${String(err)}`);
    }
  }
  if (action === "set_speed") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    const speed = clamp(Number(params["speed"] ?? 100), 1, 100);
    try {
      const ratio = await controller2.setSpeedRatio(speed);
      return {
        content: [{ type: "text", text: `\u2713 Speed ratio set to ${ratio}%` }],
        details: { speedRatio: ratio },
      };
    } catch (err) {
      return errorResult2(`set_speed failed: ${String(err)}`);
    }
  }
  if (action === "get_joints") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    try {
      const joints = await controller2.getJointPositions();
      const cfg = currentConfig2 || getCfg2("abb-crb-15000");
      const lines = cfg.joints.map(
        (j, i) =>
          `  ${j.label ?? j.id}: ${(joints[i] ?? 0).toFixed(2)}\xB0 [${j.min}\u2026${j.max}]`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Joint Positions:
${lines.join("\n")}`,
          },
        ],
        details: { joints },
      };
    } catch (err) {
      return errorResult2(`get_joints failed: ${String(err)}`);
    }
  }
  if (action === "get_world_position") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    try {
      const p = await controller2.getWorldPosition();
      return {
        content: [
          {
            type: "text",
            text: `World Pos (mm/deg):
  X:${p.x.toFixed(2)} Y:${p.y.toFixed(2)} Z:${p.z.toFixed(2)}
  Rx:${p.rx.toFixed(2)} Ry:${p.ry.toFixed(2)} Rz:${p.rz.toFixed(2)}`,
          },
        ],
        details: p,
      };
    } catch (err) {
      return errorResult2(`get_world_position failed: ${String(err)}`);
    }
  }
  if (action === "get_event_log") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    const categoryId = Number(params["category_id"] ?? params["categoryId"] ?? 0);
    const limit = clamp(Number(params["limit"] ?? 20), 1, 200);
    try {
      const result = await controller2.getEventLogEntries(categoryId, limit);
      if (!result.success) return errorResult2(String(result.error ?? "get_event_log failed"));
      const lines = result.entries.map(
        (e) => `  [${e.type}] ${String(e.timestamp).slice(0, 19)} #${e.number}: ${e.title}`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Event Log (cat ${categoryId}):
${lines.join("\n")}`,
          },
        ],
        details: result,
      };
    } catch (err) {
      return errorResult2(`get_event_log failed: ${String(err)}`);
    }
  }
  if (action === "list_tasks") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    try {
      const result = await controller2.listTasks();
      if (!result.success) return errorResult2(String(result.error ?? "list_tasks failed"));
      const lines = result.tasks.map(
        (t) => `  \u2022 ${t.taskName} [${t.executionStatus}] \u2014 ${t.modules.join(", ")}`,
      );
      return {
        content: [
          {
            type: "text",
            text: `RAPID Tasks (${result.count}):
${lines.join("\n")}`,
          },
        ],
        details: result,
      };
    } catch (err) {
      return errorResult2(`list_tasks failed: ${String(err)}`);
    }
  }
  if (action === "backup_module") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    const moduleName = String(params["module_name"] ?? params["moduleName"] ?? "");
    const taskName = String(params["task_name"] ?? params["taskName"] ?? "");
    const outputDir = String(params["output_dir"] ?? params["outputDir"] ?? ".");
    try {
      const result = await controller2.backupModule(moduleName, taskName, outputDir);
      if (!result.success) return errorResult2(String(result.error ?? "backup_module failed"));
      return {
        content: [
          { type: "text", text: `\u2713 Backed up '${result.moduleName}' to ${result.outputDir}` },
        ],
        details: result,
      };
    } catch (err) {
      return errorResult2(`backup_module failed: ${String(err)}`);
    }
  }
  if (action === "reset_program_pointer") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    const taskName = String(params["task_name"] ?? params["taskName"] ?? "T_ROB1");
    const moduleName = params["module_name"] != null ? String(params["module_name"]) : void 0;
    const routineName = params["routine_name"] != null ? String(params["routine_name"]) : void 0;
    try {
      const r = await controller2.resetProgramPointer(taskName, moduleName, routineName);
      const method = r?.method ?? "ResetProgramPointer";
      const extra = r?.moduleName ? ` \u2192 ${r.moduleName}.${r.routineName}` : "";
      return {
        content: [
          { type: "text", text: `\u2713 Program pointer reset (${taskName})${extra} [${method}]` },
        ],
        details: r ?? { taskName },
      };
    } catch (err) {
      return errorResult2(`reset_program_pointer failed: ${String(err)}`);
    }
  }
  if (action === "set_joints") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    let rawJ = params["joints"];
    if (typeof rawJ === "string")
      try {
        rawJ = JSON.parse(rawJ);
      } catch {}
    if (!Array.isArray(rawJ)) return errorResult2("joints array is required");
    const nums = rawJ.map(Number);
    if (nums.some(isNaN)) return errorResult2("joints must all be numeric");
    try {
      const cfg = currentConfig2 || getCfg2("abb-crb-15000");
      const { values, violations } = validateJointValues(cfg, nums);
      const speed = Number(params["speed"] ?? 100);
      await controller2.moveToJoints(values, speed);
      const lines = cfg.joints.map((j, i) => `  ${j.label ?? j.id}: ${values[i].toFixed(2)}\xB0`);
      let text = `\u2713 Moving to joints:
${lines.join("\n")}`;
      if (violations.length)
        text += `

\u26A0 Clamped:
${violations.map((v) => `  ${v}`).join("\n")}`;
      pushHistory(motionState2, values, "set_joints");
      return { content: [{ type: "text", text }], details: { joints: values, violations } };
    } catch (err) {
      return errorResult2(`set_joints failed: ${String(err)}`);
    }
  }
  if (action === "movj") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    let rawTarget = params["joints"];
    if (typeof rawTarget === "string")
      try {
        rawTarget = JSON.parse(rawTarget);
      } catch {}
    if (!Array.isArray(rawTarget)) return errorResult2("joints array is required");
    const targetNums = rawTarget.map(Number);
    if (targetNums.some(isNaN)) return errorResult2("joints must all be numeric");
    try {
      const cfg = currentConfig2 || getCfg2("abb-crb-15000");
      const { values: target, violations: tViol } = validateJointValues(cfg, targetNums);
      const speed = clamp(Number(params["speed"] ?? 45), 1, 100);
      const maxJointStep = clamp(Number(params["max_joint_step"] ?? 6), 0.25, 45);
      const minSamples = clamp(Number(params["min_samples"] ?? 2), 2, 50);
      const iRaw = String(params["interpolation"] ?? "cosine").toLowerCase();
      const interpolation =
        iRaw === "linear" || iRaw === "smoothstep" || iRaw === "cosine" ? iRaw : "cosine";
      const moduleName = String(params["module_name"] ?? "MoveJSegment");
      let rawStart = params["start_joints"];
      if (typeof rawStart === "string")
        try {
          rawStart = JSON.parse(rawStart);
        } catch {}
      let start;
      let sViol = [];
      if (Array.isArray(rawStart)) {
        const sNums = rawStart.map(Number);
        if (sNums.some(isNaN)) return errorResult2("start_joints must all be numeric");
        const sv = validateJointValues(cfg, sNums);
        start = sv.values;
        sViol = sv.violations;
      } else if (motionState2.lastTarget && motionState2.lastTarget.length === target.length) {
        start = [...motionState2.lastTarget];
      } else {
        start = await controller2.getJointPositions();
      }
      const wps = interpolateJoints(start, target, maxJointStep, minSamples, interpolation);
      const rapidCode = controller2.generateRapidSequence(
        wps.map((joints, idx) => ({
          joints,
          speed,
          zone: idx === wps.length - 1 ? "fine" : "z10",
        })),
        moduleName,
      );
      await controller2.executeRapidProgram(rapidCode, moduleName);
      pushHistory(motionState2, target, "movj");
      const violations = [...sViol, ...tViol];
      let text = `\u2713 MoveJ  speed:${speed}  wpts:${wps.length}  interp:${interpolation}
  End:[${target.map((v) => v.toFixed(2)).join(",")}]`;
      if (violations.length)
        text += `
\u26A0 Clamped:
${violations.map((v) => `  ${v}`).join("\n")}`;
      return {
        content: [{ type: "text", text }],
        details: { speed, waypoints: wps.length, start, end: target, moduleName, violations },
      };
    } catch (err) {
      return errorResult2(`movj failed: ${String(err)}`);
    }
  }
  if (action === "movj_rapid") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    let rawJ = params["joints"];
    if (typeof rawJ === "string")
      try {
        rawJ = JSON.parse(rawJ);
      } catch {}
    if (!Array.isArray(rawJ)) return errorResult2("joints array is required");
    const nums = rawJ.map(Number);
    if (nums.some(isNaN)) return errorResult2("joints must all be numeric");
    try {
      const cfg = currentConfig2 || getCfg2("abb-crb-15000");
      const { values, violations } = validateJointValues(cfg, nums);
      const speed = clamp(Number(params["speed"] ?? 20), 1, 100);
      const zone = String(params["zone"] ?? "fine");
      const rapidCode = controller2.generateRapidMoveJoints(values, speed, zone);
      await controller2.executeRapidProgram(rapidCode, "OpenClawMotionMod", true);
      pushHistory(motionState2, values, "movj_rapid");
      let text = `\u2713 movj_rapid  joints:[${values.map((v) => v.toFixed(2)).join(",")}]  speed:${speedToRapidConst(speed)}  zone:${zone}`;
      if (violations.length)
        text += `
\u26A0 Clamped:
${violations.map((v) => `  ${v}`).join("\n")}`;
      return {
        content: [{ type: "text", text }],
        details: { joints: values, speed, zone, violations },
      };
    } catch (err) {
      return errorResult2(`movj_rapid failed: ${String(err)}`);
    }
  }
  if (action === "go_home") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    try {
      const cfg = currentConfig2 || getCfg2("abb-crb-15000");
      const homeJoints = cfg.joints.map((j) => j.home);
      await controller2.moveToJoints(homeJoints);
      pushHistory(motionState2, homeJoints, "go_home");
      return {
        content: [{ type: "text", text: "\u2713 Moving to home position" }],
        details: { joints: homeJoints },
      };
    } catch (err) {
      return errorResult2(`go_home failed: ${String(err)}`);
    }
  }
  if (action === "set_preset") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    const presetName = String(params["preset"] ?? "").trim();
    if (!presetName) return errorResult2("preset name is required");
    try {
      const cfg = currentConfig2 || getCfg2("abb-crb-15000");
      const joints = resolvePreset(cfg, presetName);
      const speed = Number(params["speed"] ?? 100);
      await controller2.moveToJoints(joints, speed);
      pushHistory(motionState2, joints, `preset:${presetName}`);
      const lines = cfg.joints.map((j, i) => `  ${j.label ?? j.id}: ${joints[i].toFixed(2)}\xB0`);
      return {
        content: [
          {
            type: "text",
            text: `\u2713 Preset "${presetName}":
${lines.join("\n")}`,
          },
        ],
        details: { preset: presetName, joints },
      };
    } catch (err) {
      return errorResult2(String(err));
    }
  }
  if (action === "run_sequence") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    const seqName = String(params["sequence"] ?? "").trim();
    if (!seqName) return errorResult2("sequence name is required");
    try {
      const cfg = currentConfig2 || getCfg2("abb-crb-15000");
      const seq = resolveSequence(cfg, seqName);
      const positions = seq.steps.map((s) => ({
        joints: s.joints,
        speed: s.speed ?? 100,
        zone: s.zone ?? "z10",
      }));
      const rapidCode = controller2.generateRapidSequence(positions);
      await controller2.executeRapidProgram(rapidCode);
      if (seq.steps.length > 0)
        pushHistory(motionState2, seq.steps[seq.steps.length - 1].joints, `seq:${seqName}`);
      return {
        content: [
          { type: "text", text: `\u2713 Sequence "${seqName}" (${seq.steps.length} steps)` },
        ],
        details: { sequence: seqName, steps: seq.steps.length },
      };
    } catch (err) {
      return errorResult2(String(err));
    }
  }
  if (action === "list_robots") {
    const robots = listRobots();
    const lines = robots.map((r) => {
      try {
        const c = getCfg2(r);
        return `  \u2022 ${r} \u2014 ${c.manufacturer} ${c.model} (${c.dof} DOF)`;
      } catch {
        return `  \u2022 ${r}`;
      }
    });
    return {
      content: [
        {
          type: "text",
          text: `Robots:
${lines.join("\n")}`,
        },
      ],
      details: { robots },
    };
  }
  if (action === "list_presets") {
    const robotId = String(params["robot_id"] ?? currentConfig2?.id ?? "abb-crb-15000");
    try {
      const cfg = getCfg2(robotId);
      const presets = Object.keys(cfg.presets ?? {});
      return {
        content: [
          {
            type: "text",
            text: presets.length
              ? `Presets for ${robotId}:
${presets.map((p) => `  \u2022 ${p}`).join("\n")}`
              : "No presets defined",
          },
        ],
        details: { robotId, presets },
      };
    } catch (err) {
      return errorResult2(String(err));
    }
  }
  if (action === "list_sequences") {
    const robotId = String(params["robot_id"] ?? currentConfig2?.id ?? "abb-crb-15000");
    try {
      const cfg = getCfg2(robotId);
      const seqs = Object.entries(cfg.sequences ?? {}).map(
        ([k, v]) => `  \u2022 ${k}${v.description ? ` \u2014 ${v.description}` : ""}`,
      );
      return {
        content: [
          {
            type: "text",
            text: seqs.length
              ? `Sequences for ${robotId}:
${seqs.join("\n")}`
              : "No sequences defined",
          },
        ],
        details: { robotId, sequences: Object.keys(cfg.sequences ?? {}) },
      };
    } catch (err) {
      return errorResult2(String(err));
    }
  }
  if (action === "execute_rapid") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    const code = String(params["rapid_code"] ?? params["code"] ?? "");
    if (!code) return errorResult2("rapid_code or code parameter is required");
    const moduleName = String(params["module_name"] ?? "OpenClawMotionMod");
    const allowReal = params["allow_real_execution"] !== false;
    try {
      await controller2.executeRapidProgram(code, moduleName, allowReal);
      return {
        content: [{ type: "text", text: `\u2713 RAPID executed (${moduleName})` }],
        details: { moduleName },
      };
    } catch (err) {
      return errorResult2(`execute_rapid failed: ${String(err)}`);
    }
  }
  if (action === "load_rapid") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    const code = String(params["rapid_code"] ?? params["code"] ?? "");
    if (!code) return errorResult2("rapid_code or code parameter is required");
    const allowReal = Boolean(params["allow_real_execution"] ?? false);
    try {
      await controller2.loadRapidProgram(code, allowReal);
      return {
        content: [{ type: "text", text: "\u2713 RAPID program loaded" }],
        details: { loaded: true },
      };
    } catch (err) {
      return errorResult2(`load_rapid failed: ${String(err)}`);
    }
  }
  if (action === "start_program") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    const allowReal = Boolean(params["allow_real_execution"] ?? true);
    try {
      await controller2.startRapid(allowReal);
      return {
        content: [{ type: "text", text: "\u2713 RAPID program started" }],
        details: { running: true },
      };
    } catch (err) {
      return errorResult2(`start_program failed: ${String(err)}`);
    }
  }
  if (action === "stop_program") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    try {
      await controller2.stopRapid();
      return {
        content: [{ type: "text", text: "\u2713 RAPID program stopped" }],
        details: { running: false },
      };
    } catch (err) {
      return errorResult2(`stop_program failed: ${String(err)}`);
    }
  }
  if (action === "motors_on" || action === "motors_off") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    try {
      await controller2.setMotors(action === "motors_on" ? "ON" : "OFF");
      return {
        content: [{ type: "text", text: `\u2713 Motors ${action === "motors_on" ? "ON" : "OFF"}` }],
        details: { motorState: action === "motors_on" ? "ON" : "OFF" },
      };
    } catch (err) {
      return errorResult2(`${action} failed: ${String(err)}`);
    }
  }
  if (action === "identify_robot") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    try {
      const { identifyRobot: identifyRobot2 } = await Promise.resolve().then(
        () => (init_robot_config_loader(), robot_config_loader_exports),
      );
      const liveJoints = await controller2.getJointPositions();
      const cfg = currentConfig2 || getCfg2("abb-crb-15000");
      const jointCfgs = liveJoints.map((_, i) => ({
        index: i,
        id: `joint${i}`,
        type: "revolute",
        min: cfg.joints[i]?.min ?? -180,
        max: cfg.joints[i]?.max ?? 180,
        home: cfg.joints[i]?.home ?? 0,
      }));
      const id = identifyRobot2(jointCfgs);
      if (id) {
        const ic = getCfg2(id);
        return {
          content: [
            { type: "text", text: `\u2713 Identified: ${ic.manufacturer} ${ic.model} (${id})` },
          ],
          details: { robotId: id, manufacturer: ic.manufacturer, model: ic.model },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `\u26A0 Could not identify robot (${liveJoints.length} DOF). Specify robot_id manually.`,
          },
        ],
        details: { identified: false },
      };
    } catch (err) {
      return errorResult2(`identify_robot failed: ${String(err)}`);
    }
  }
  if (action === "get_motion_memory") {
    return {
      content: [
        {
          type: "text",
          text: `Motion memory:
  Last: ${motionState2.lastTarget ? `[${motionState2.lastTarget.map((v) => v.toFixed(2)).join(",")}]` : "(none)"}
  History: ${motionState2.history.length} entries`,
        },
      ],
      details: {
        lastTarget: motionState2.lastTarget,
        historyCount: motionState2.history.length,
        recent: motionState2.history.slice(-10),
      },
    };
  }
  if (action === "reset_motion_memory") {
    motionState2.lastTarget = null;
    motionState2.history = [];
    return {
      content: [{ type: "text", text: "\u2713 Motion memory reset" }],
      details: { reset: true },
    };
  }
  if (action === "dance_two_points") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    const rawA = params["point_a"];
    const rawB = params["point_b"];
    if (!Array.isArray(rawA) || !Array.isArray(rawB))
      return errorResult2("point_a and point_b arrays are required");
    const pA = rawA.map(Number);
    const pB = rawB.map(Number);
    if (pA.some(isNaN) || pB.some(isNaN))
      return errorResult2("point_a and point_b must be numeric");
    try {
      const cfg = currentConfig2 || getCfg2("abb-crb-15000");
      const { values: pointA, violations: vA } = validateJointValues(cfg, pA);
      const { values: pointB, violations: vB } = validateJointValues(cfg, pB);
      const repeat = clamp(Number(params["repeat"] ?? 2), 1, 64);
      const speed = clamp(Number(params["speed"] ?? 45), 1, 100);
      const maxJointStep = clamp(Number(params["max_joint_step"] ?? 6), 0.25, 45);
      const minSamples = clamp(Number(params["min_samples"] ?? 2), 2, 50);
      const iRaw = String(params["interpolation"] ?? "cosine").toLowerCase();
      const interpolation =
        iRaw === "linear" || iRaw === "smoothstep" || iRaw === "cosine" ? iRaw : "cosine";
      const result = await executeContinuousDance(controller2, cfg, motionState2, {
        pointA,
        pointB,
        repeat,
        speed,
        maxJointStep,
        minSamples,
        interpolation,
        autoConnect: params["auto_connect"] !== false,
        returnToA: params["return_to_a"] === true,
        moduleName: String(params["module_name"] ?? "DanceSegment"),
        source: "dance_two_points",
      });
      const violations = [...vA, ...vB];
      let text = `\u2713 Dance  repeat:${result.repeat}  wpts:${result.waypoints}  speed:${result.speed}  interp:${result.interpolation}`;
      if (violations.length)
        text += `
\u26A0 Clamped:
${violations.map((v) => `  ${v}`).join("\n")}`;
      return { content: [{ type: "text", text }], details: { ...result, violations } };
    } catch (err) {
      return errorResult2(`dance_two_points failed: ${String(err)}`);
    }
  }
  if (action === "dance_template") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    try {
      const cfg = currentConfig2 || getCfg2("abb-crb-15000");
      const template = String(params["template"] ?? "wave").toLowerCase();
      const amplitude = clamp(Number(params["amplitude"] ?? 1), 0.1, 2);
      const beats = clamp(Number(params["beats"] ?? 8), 2, 64);
      const speed = clamp(Number(params["speed"] ?? 45), 1, 100);
      const maxJointStep = clamp(Number(params["max_joint_step"] ?? 6), 0.25, 45);
      const minSamples = clamp(Number(params["min_samples"] ?? 2), 2, 50);
      const iRaw = String(params["interpolation"] ?? "cosine").toLowerCase();
      const interpolation =
        iRaw === "linear" || iRaw === "smoothstep" || iRaw === "cosine" ? iRaw : "cosine";
      const { pointA, pointB } = buildTemplatePoints(cfg, template, amplitude);
      const repeat = Math.max(1, Math.floor(beats / 2));
      const result = await executeContinuousDance(controller2, cfg, motionState2, {
        pointA,
        pointB,
        repeat,
        speed,
        maxJointStep,
        minSamples,
        interpolation,
        autoConnect: params["auto_connect"] !== false,
        returnToA: params["return_to_a"] === true,
        moduleName: String(params["module_name"] ?? `DanceTemplate_${template}`),
        source: `dance_template:${template}`,
      });
      return {
        content: [
          {
            type: "text",
            text: `\u2713 Dance template '${template}'  beats:${beats}  repeat:${result.repeat}  wpts:${result.waypoints}`,
          },
        ],
        details: { template, amplitude, beats, ...result },
      };
    } catch (err) {
      return errorResult2(`dance_template failed: ${String(err)}`);
    }
  }
  if (action === "get_event_log_categories") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    try {
      const result = await controller2.getEventLogCategories();
      if (!result.success)
        return errorResult2(String(result.error ?? "get_event_log_categories failed"));
      const lines = result.categories.map(
        (c) => `  cat[${c.categoryId}] ${c.name}: ${c.count} entries`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Event Log Categories:
${lines.join("\n")}`,
          },
        ],
        details: result,
      };
    } catch (err) {
      return errorResult2(`get_event_log_categories failed: ${String(err)}`);
    }
  }
  if (action === "get_rapid_variable") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    const taskName = String(params["task_name"] ?? params["taskName"] ?? "T_ROB1");
    const varName = String(params["var_name"] ?? params["varName"] ?? "");
    const moduleName = String(params["module_name"] ?? params["moduleName"] ?? "");
    if (!varName) return errorResult2("var_name is required");
    try {
      const result = await controller2.getRapidVariable(taskName, varName, moduleName);
      if (!result.success) return errorResult2(String(result.error ?? "get_rapid_variable failed"));
      return {
        content: [
          { type: "text", text: `${result.varName} (${result.dataType}) = ${result.value}` },
        ],
        details: result,
      };
    } catch (err) {
      return errorResult2(`get_rapid_variable failed: ${String(err)}`);
    }
  }
  if (action === "get_io_signals") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    const nameFilter = String(params["name_filter"] ?? params["nameFilter"] ?? "");
    const limit = Math.max(1, Math.min(500, Number(params["limit"] ?? 100)));
    try {
      const result = await controller2.getIOSignals(nameFilter, limit);
      if (!result.success) return errorResult2(String(result.error ?? "get_io_signals failed"));
      const lines = result.signals.map(
        (s) => `  [${s.type}] ${s.name} = ${s.value}${s.unit ? " " + s.unit : ""}`,
      );
      return {
        content: [
          {
            type: "text",
            text: `IO Signals (${result.count}):
${lines.join("\n")}`,
          },
        ],
        details: result,
      };
    } catch (err) {
      return errorResult2(`get_io_signals failed: ${String(err)}`);
    }
  }
  if (action === "list_rapid_variables") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    const taskName = String(params["task_name"] ?? params["taskName"] ?? "T_ROB1");
    const moduleName = String(params["module_name"] ?? params["moduleName"] ?? "");
    const limit = Math.max(1, Math.min(200, Number(params["limit"] ?? 50)));
    try {
      const result = await controller2.listRapidVariables(taskName, moduleName, limit);
      if (!result.success)
        return errorResult2(String(result.error ?? "list_rapid_variables failed"));
      const lines = result.variables.map(
        (v) =>
          `  \u2022 ${v.name} [${v.rapidType ?? "?"}] = ${v.value ?? "?"} (${v.moduleName ?? taskName})`,
      );
      return {
        content: [
          {
            type: "text",
            text: `RAPID Variables (${result.count}):
${lines.join("\n")}`,
          },
        ],
        details: result,
      };
    } catch (err) {
      return errorResult2(`list_rapid_variables failed: ${String(err)}`);
    }
  }
  if (action === "movl") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    const x = Number(params["x"]);
    const y = Number(params["y"]);
    const z = Number(params["z"]);
    const rx = Number(params["rx"]);
    const ry = Number(params["ry"]);
    const rz = Number(params["rz"]);
    if (isNaN(x) || isNaN(y) || isNaN(z) || isNaN(rx) || isNaN(ry) || isNaN(rz)) {
      return errorResult2("x, y, z, rx, ry, rz are required for movl");
    }
    const speed = clamp(Number(params["speed"] ?? 100), 1, 7e3);
    const zone = String(params["zone"] ?? "fine");
    try {
      await controller2.moveLinear(x, y, z, rx, ry, rz, speed, zone);
      return {
        content: [{ type: "text", text: `\u2713 movl to [${x},${y},${z}] at speed ${speed}` }],
        details: { x, y, z, rx, ry, rz, speed, zone },
      };
    } catch (err) {
      return errorResult2(`movl failed: ${String(err)}`);
    }
  }
  if (action === "movc") {
    if (!controller2?.isConnected()) return errorResult2("Not connected. Use 'connect' first.");
    const rCirc = params["circ_point"];
    const rTo = params["to_point"];
    if (!Array.isArray(rCirc) || !Array.isArray(rTo) || rCirc.length < 6 || rTo.length < 6) {
      return errorResult2(
        "circ_point and to_point must be arrays of at least 6 numbers [x,y,z,rx,ry,rz]",
      );
    }
    const circPoint = rCirc.map(Number);
    const toPoint = rTo.map(Number);
    if (circPoint.some(isNaN) || toPoint.some(isNaN))
      return errorResult2("circ_point and to_point must be numeric");
    const speed = clamp(Number(params["speed"] ?? 100), 1, 7e3);
    const zone = String(params["zone"] ?? "fine");
    try {
      await controller2.moveCircular(circPoint, toPoint, speed, zone);
      return {
        content: [
          {
            type: "text",
            text: `\u2713 movc through [${circPoint.slice(0, 3).join(",")}] to [${toPoint.slice(0, 3).join(",")}] at speed ${speed}`,
          },
        ],
        details: { circPoint, toPoint, speed, zone },
      };
    } catch (err) {
      return errorResult2(`movc failed: ${String(err)}`);
    }
  }
  if (action === "set_rapid_variable") {
    if (!controller2?.isConnected()) return errorResult2("Not connected");
    const taskName = String(params["task_name"] ?? params["taskName"] ?? "T_ROB1");
    const moduleName = String(params["module_name"] ?? params["moduleName"] ?? "");
    const varName = String(params["var_name"] ?? params["varName"] ?? "");
    const value = String(params["value"] ?? "");
    if (!varName || !value) return errorResult2("var_name and value are required");
    try {
      const result = await controller2.setRapidVariable(taskName, moduleName, varName, value);
      if (!result.success) return errorResult2(String(result.error ?? "set_rapid_variable failed"));
      return {
        content: [{ type: "text", text: `\u2713 Set ${result.varName} = ${result.value}` }],
        details: result,
      };
    } catch (err) {
      return errorResult2(`set_rapid_variable failed: ${String(err)}`);
    }
  }
  return errorResult2(`Unknown action: "${action}"`);
}

// src/abb-robot-tool.ts
init_robot_config_loader();
var ABB_PLUGIN_VERSION = "1.1.0";
var controller = null;
var currentConfig = null;
var configCache = /* @__PURE__ */ new Map();
var motionState = {
  lastTarget: null,
  history: [],
};
function getCfg(robotId) {
  if (!configCache.has(robotId)) {
    configCache.set(robotId, loadRobotConfig(robotId));
  }
  return configCache.get(robotId);
}
function errorResult(message) {
  return {
    content: [{ type: "text", text: `\u274C abb_robot error: ${message}` }],
    details: { error: message },
  };
}
function createABBRobotTool(pluginConfig) {
  return {
    name: "abb_robot",
    label: "ABB Robot Control",
    description:
      "Control ABB robots via PC SDK. Connect to controllers, scan network for controllers, move robots to joint positions, execute RAPID programs, apply presets, run motion sequences, query status and event logs, manage speed ratio, backup modules, and manage RAPID tasks.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            // Connection
            "connect",
            "disconnect",
            "scan_controllers",
            // Status & info
            "get_status",
            "get_system_info",
            "get_service_info",
            "get_version",
            // Position
            "get_joints",
            "set_joints",
            "get_world_position",
            // Speed
            "get_speed",
            "set_speed",
            // Motion
            "movj",
            "movj_rapid",
            "go_home",
            "movl",
            "movc",
            // Presets & sequences
            "set_preset",
            "run_sequence",
            "list_robots",
            "list_presets",
            "list_sequences",
            // RAPID
            "execute_rapid",
            "load_rapid",
            "start_program",
            "stop_program",
            "reset_program_pointer",
            // Tasks & modules
            "list_tasks",
            "backup_module",
            // Event log
            "get_event_log",
            // Motors
            "motors_on",
            "motors_off",
            // Robot identification
            "identify_robot",
            // Dance / creative motion
            "dance_two_points",
            "dance_template",
            // Motion memory
            "get_motion_memory",
            "reset_motion_memory",
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
        joints: {
          type: "array",
          items: { type: "number" },
          description: "Joint angles in degrees [j1..j6]",
        },
        start_joints: {
          type: "array",
          items: { type: "number" },
          description: "Optional MoveJ start joints in degrees",
        },
        x: { type: "number", description: "Cartesian X coordinate" },
        y: { type: "number", description: "Cartesian Y coordinate" },
        z: { type: "number", description: "Cartesian Z coordinate" },
        rx: { type: "number", description: "Euler X angle (deg)" },
        ry: { type: "number", description: "Euler Y angle (deg)" },
        rz: { type: "number", description: "Euler Z angle (deg)" },
        circ_point: {
          type: "array",
          items: { type: "number" },
          description: "Midpoint [x,y,z,rx,ry,rz] for movc",
        },
        to_point: {
          type: "array",
          items: { type: "number" },
          description: "End point [x,y,z,rx,ry,rz] for movc",
        },
        speed: {
          type: "number",
          description: "Speed: 1-100 for motion actions; 1-7000 for set_speed (mm/s TCP)",
        },
        zone: {
          type: "string",
          description: "Motion zone: fine | z1 | z5 | z10 | z50 (default: fine)",
        },
        // Presets & sequences
        preset: { type: "string", description: "Named preset key" },
        sequence: { type: "string", description: "Named sequence key" },
        // RAPID
        code: { type: "string", description: "RAPID program source code (same as rapid_code)" },
        rapid_code: { type: "string", description: "RAPID program source code" },
        module_name: {
          type: "string",
          description: "RAPID module name (default: OpenClawMotionMod)",
        },
        allow_real_execution: {
          type: "boolean",
          description: "Permit execution on real (non-virtual) controllers",
        },
        // movj_rapid
        task_name: { type: "string", description: "RAPID task name (default: T_ROB1)" },
        program_timeout_ms: {
          type: "number",
          description: "Max wait ms for RAPID completion (default: 60000)",
        },
        // Event log
        category_id: { type: "number", description: "Event log category (0=common, default: 0)" },
        limit: { type: "number", description: "Max entries to return (default: 20)" },
        // Backup
        output_dir: { type: "string", description: "Local directory to write backup file" },
        // Dance
        point_a: {
          type: "array",
          items: { type: "number" },
          description: "Dance point A joint angles",
        },
        point_b: {
          type: "array",
          items: { type: "number" },
          description: "Dance point B joint angles",
        },
        repeat: { type: "number", description: "A/B oscillation count (default: 2)" },
        max_joint_step: {
          type: "number",
          description: "Max interpolation step per joint in degrees (default: 6)",
        },
        min_samples: {
          type: "number",
          description: "Min interpolation samples per segment (default: 2)",
        },
        interpolation: {
          type: "string",
          description: "Interpolation: linear | smoothstep | cosine",
        },
        auto_connect: {
          type: "boolean",
          description: "Auto-connect from previous endpoint to point A (default: true)",
        },
        return_to_a: {
          type: "boolean",
          description: "Return to point A after dance segment (default: false)",
        },
        template: { type: "string", description: "Dance template: wave | bounce | sway | twist" },
        amplitude: {
          type: "number",
          description: "Template amplitude scale 0.1-2.0 (default: 1.0)",
        },
        beats: {
          type: "number",
          description: "Template beats mapped to repeat count (default: 8)",
        },
        // New actions
        var_name: { type: "string", description: "RAPID variable name" },
        value: { type: "string", description: "RAPID variable value (for set_rapid_variable)" },
        name_filter: { type: "string", description: "IO signal name filter substring" },
        routine_name: {
          type: "string",
          description: "PROC name for reset_program_pointer (optional; auto-detected if omitted)",
        },
      },
      required: ["action"],
    },
    execute: async (_id, params) => {
      const action = String(params["action"] ?? "");
      if (action === "get_version") {
        return {
          content: [{ type: "text", text: `abb_robot plugin v${ABB_PLUGIN_VERSION}` }],
          details: { plugin: "abb-robot-control", version: ABB_PLUGIN_VERSION },
        };
      }
      if (action === "scan_controllers") {
        try {
          const tempCtrl = createController({ host: "" });
          const result = await tempCtrl.scanControllers();
          if (!result.success) return errorResult(String(result.error ?? "Scan failed"));
          const lines = result.controllers.map(
            (c) =>
              `  \u2022 ${c.ip} \u2014 ${c.systemName} (${c.isVirtual ? "virtual" : "real"}) id=${c.id}`,
          );
          return {
            content: [
              {
                type: "text",
                text:
                  result.total === 0
                    ? "No ABB controllers found on the network."
                    : `Found ${result.total} controller(s):
${lines.join("\n")}`,
              },
            ],
            details: result,
          };
        } catch (err) {
          return errorResult(`scan_controllers failed: ${String(err)}`);
        }
      }
      if (action === "connect") {
        const host = String(params["host"] ?? pluginConfig["controllerHost"] ?? "");
        if (!host) return errorResult("host parameter or controllerHost config is required");
        const port = Number(params["port"] ?? pluginConfig["controllerPort"] ?? 7e3);
        const robotId = String(params["robot_id"] ?? pluginConfig["defaultRobot"] ?? "");
        try {
          if (controller?.isConnected()) await controller.disconnect();
          const config = { host, port };
          controller = createController(config);
          await controller.connect();
          const systemName = controller.getSystemName();
          let identifiedRobot = robotId;
          if (!identifiedRobot) {
            const joints = await controller.getJointPositions();
            const jointConfigs = joints.map((_, i) => ({
              index: i,
              id: `joint${i}`,
              type: "revolute",
              min: -180,
              max: 180,
              home: 0,
            }));
            identifiedRobot = identifyRobot(jointConfigs) || "abb-crb-15000";
          }
          currentConfig = getCfg(identifiedRobot);
          try {
            motionState.lastTarget = await controller.getJointPositions();
            motionState.history.push({
              timestamp: /* @__PURE__ */ new Date().toISOString(),
              joints: [...motionState.lastTarget],
              source: "connect-sync",
            });
          } catch {
            motionState.lastTarget = null;
          }
          return {
            content: [
              {
                type: "text",
                text: `\u2713 Connected to ABB controller at ${host}:${port}
System: ${systemName}
Robot: ${currentConfig.manufacturer} ${currentConfig.model} (${currentConfig.id})`,
              },
            ],
            details: { connected: true, host, port, systemName, robotId: currentConfig.id },
          };
        } catch (err) {
          return errorResult(`Connection failed: ${String(err)}`);
        }
      }
      return handleAction(
        action,
        params,
        controller,
        currentConfig,
        pluginConfig,
        getCfg,
        errorResult,
        motionState,
      );
    },
  };
}

// index.ts
var plugin = {
  id: "abb-robot-control",
  name: "ABB Robot Control",
  description:
    "Control actual ABB robots via PC SDK. Connect to robot controllers, execute RAPID programs, move robots, and manage motion sequences. Supports automatic robot identification and multi-robot configurations.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      controllerHost: {
        type: "string",
        description: "Default ABB robot controller IP address or hostname",
      },
      controllerPort: {
        type: "number",
        description: "Default controller port (default: 7000)",
        minimum: 1,
        maximum: 65535,
      },
      defaultRobot: {
        type: "string",
        description: "Default robot configuration ID (e.g. 'abb-crb-15000')",
      },
      autoConnect: {
        type: "boolean",
        description: "Automatically connect to controller on startup",
      },
      rapidProgramPath: {
        type: "string",
        description: "Path on controller to store generated RAPID programs",
      },
      defaultMode: {
        type: "string",
        description: "Default operation mode: virtual, real, or auto",
        enum: ["virtual", "real", "auto"],
      },
      wsBridgePort: {
        type: "number",
        description: "WebSocket bridge port for virtual mode",
        minimum: 1,
        maximum: 65535,
      },
    },
  },
  register(api, config) {
    config = config || {};
    const tool = createABBRobotTool(config);
    api.registerTool(tool);
    if (config.autoConnect && config.controllerHost) {
      setTimeout(async () => {
        try {
          const mode = config.defaultMode || "real";
          await tool.execute("auto-connect", {
            action: "connect",
            mode,
            host: config.controllerHost,
            port: mode === "virtual" ? config.wsBridgePort || 9877 : config.controllerPort || 7e3,
            robot_id: config.defaultRobot,
          });
          console.log("[abb-robot-control] Auto-connected to controller");
        } catch (err) {
          console.warn("[abb-robot-control] Auto-connect failed:", err);
        }
      }, 2e3);
    }
  },
};
var index_default = plugin;
export { index_default as default };
