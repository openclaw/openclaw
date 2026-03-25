/**
 * abb-controller.ts
 * ABB Robot Controller — TypeScript facade over ABBCSharpBridge.
 *
 * All public methods map 1-to-1 to C# ABBBridge methods exposed in ABBBridge.cs.
 * The bridge is instantiated once per ABBController and reused across calls so
 * the underlying C# object retains its connection state.
 */

import { EventEmitter } from "node:events";
import { ABBCSharpBridge } from "./abb-csharp-bridge.js";

export interface ControllerConfig {
  host: string;
  port?: number;
  systemName?: string;
  userName?: string;
  password?: string;
}

export interface ControllerStatus {
  connected: boolean;
  operationMode?: string;
  motorState?: string;
  rapidRunning?: boolean;
  rapidExecutionStatus?: string;
  systemName?: string;
}

export interface ScanResult {
  success: boolean;
  total: number;
  controllers: Array<{
    ip: string;
    id: string;
    isVirtual: boolean;
    version: string;
    systemId: string;
    systemName: string;
    hostName: string;
    controllerName: string;
  }>;
}

/**
 * ABBController — manages one connection to an ABB robot controller.
 * Instantiate a fresh instance per session; it owns a single ABBCSharpBridge.
 */
export class ABBController extends EventEmitter {
  private config: ControllerConfig;
  private _connected: boolean = false;
  private _systemName: string = "";
  private bridge: ABBCSharpBridge;

  constructor(config: ControllerConfig) {
    super();
    this.config = { port: 7000, ...config };
    this.bridge = new ABBCSharpBridge();
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this._connected) throw new Error("Already connected to controller");
    const result = await this.bridge.connect(this.config.host);
    if (!result.success) throw new Error(result.error ?? "Failed to connect to controller");
    this._connected = true;
    this._systemName = String(result.systemName ?? "");
    this.emit("connected", { systemName: this._systemName });
  }

  async disconnect(): Promise<void> {
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
  async scanControllers(): Promise<ScanResult> {
    const r = await this.bridge.scanControllers();
    return r as unknown as ScanResult;
  }

  // ── Status & Info ──────────────────────────────────────────────────────────

  async getStatus(): Promise<ControllerStatus> {
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

  async getSystemInfo(): Promise<Record<string, unknown>> {
    this._ensureConnected();
    return this.bridge.getSystemInfo();
  }

  async getServiceInfo(): Promise<Record<string, unknown>> {
    this._ensureConnected();
    return this.bridge.getServiceInfo();
  }

  // ── Speed ──────────────────────────────────────────────────────────────────

  async getSpeedRatio(): Promise<number> {
    this._ensureConnected();
    const r = await this.bridge.getSpeedRatio();
    if (!r.success) throw new Error(String(r.error ?? "getSpeedRatio failed"));
    return Number(r.speedRatio);
  }

  async setSpeedRatio(speed: number): Promise<number> {
    this._ensureConnected();
    const r = await this.bridge.setSpeedRatio(speed);
    if (!r.success) throw new Error(String(r.error ?? "setSpeedRatio failed"));
    return Number(r.speedRatio);
  }

  // ── Position ───────────────────────────────────────────────────────────────

  async getJointPositions(): Promise<number[]> {
    this._ensureConnected();
    return this.bridge.getJointPositions();
  }

  async getWorldPosition(): Promise<{ x: number; y: number; z: number; rx: number; ry: number; rz: number }> {
    this._ensureConnected();
    const r = await this.bridge.getWorldPosition();
    if (!r.success) throw new Error(String(r.error ?? "getWorldPosition failed"));
    return {
      x: Number(r.x), y: Number(r.y), z: Number(r.z),
      rx: Number(r.rx), ry: Number(r.ry), rz: Number(r.rz),
    };
  }

  // ── Event Log ──────────────────────────────────────────────────────────────

  async getEventLogEntries(categoryId: number = 0, limit: number = 20): Promise<Record<string, unknown>> {
    this._ensureConnected();
    return this.bridge.getEventLogEntries(categoryId, limit);
  }

  // ── Tasks & Modules ────────────────────────────────────────────────────────

  async listTasks(): Promise<Record<string, unknown>> {
    this._ensureConnected();
    return this.bridge.listTasks();
  }

  async backupModule(
    moduleName: string = "",
    taskName: string = "",
    outputDir: string = "."
  ): Promise<Record<string, unknown>> {
    this._ensureConnected();
    return this.bridge.backupModule(moduleName, taskName, outputDir);
  }

  async resetProgramPointer(taskName: string = "T_ROB1", moduleName?: string, routineName?: string): Promise<BridgeResult> {
    this._ensureConnected();
    const r = await this.bridge.resetProgramPointer(taskName, moduleName, routineName);
    if (!r.success) throw new Error(String(r.error ?? "resetProgramPointer failed"));
    return r;
  }

  // ── RAPID ──────────────────────────────────────────────────────────────────

  /** Load RAPID code to the controller without starting execution. */
  async loadRapidProgram(
    code: string,
    allowRealExecution: boolean = false
  ): Promise<void> {
    this._ensureConnected();
    const r = await this.bridge.loadRapidProgram(code, allowRealExecution);
    if (!r.success) throw new Error(String(r.error ?? "loadRapidProgram failed"));
  }

  /** Start previously loaded RAPID program. */
  async startRapid(allowRealExecution: boolean = true): Promise<void> {
    this._ensureConnected();
    const r = await this.bridge.startRapid(allowRealExecution);
    if (!r.success) throw new Error(String(r.error ?? "startRapid failed"));
  }

  /** Stop currently running RAPID program. */
  async stopRapid(): Promise<void> {
    this._ensureConnected();
    const r = await this.bridge.stopRapid();
    if (!r.success) throw new Error(String(r.error ?? "stopRapid failed"));
  }

  /**
   * Execute a RAPID program end-to-end via C# ExecuteRapidProgram
   * (load → reset pointer → start → event-driven wait for completion).
   */
  async executeRapidProgram(
    code: string,
    moduleName: string = "OpenClawMotionMod",
    allowRealExecution: boolean = true
  ): Promise<void> {
    this._ensureConnected();
    const r = await this.bridge.executeRapidProgram(code, moduleName, allowRealExecution);
    if (!r.success) throw new Error(String(r.error ?? "executeRapidProgram failed"));
  }

  // ── Motion ─────────────────────────────────────────────────────────────────

  /**
   * Move robot to absolute joint positions.
   * Internally uses ABBBridge.MoveToJoints which generates and executes RAPID.
   */
  async moveToJoints(
    joints: number[],
    speed: number = 100,
    zone: string = "fine"
  ): Promise<void> {
    this._ensureConnected();
    const r = await this.bridge.moveToJoints(joints, speed, zone);
    if (!r.success) throw new Error(String(r.error ?? "moveToJoints failed"));
  }

  /** Move linearly (Cartesian) to the specified XYZ/Euler target. */
  async moveLinear(
    x: number, y: number, z: number,
    rx: number, ry: number, rz: number,
    speed: number = 100,
    zone: string = "fine"
  ): Promise<void> {
    this._ensureConnected();
    const r = await this.bridge.moveLinear(x, y, z, rx, ry, rz, speed, zone);
    if (!r.success) throw new Error(String(r.error ?? "moveLinear failed"));
  }

  /** Move circularly from current pos through circPoint to toPoint (XYZ/Euler). */
  async moveCircular(
    circPoint: number[],
    toPoint: number[],
    speed: number = 100,
    zone: string = "fine"
  ): Promise<void> {
    this._ensureConnected();
    const r = await this.bridge.moveCircular(circPoint, toPoint, speed, zone);
    if (!r.success) throw new Error(String(r.error ?? "moveCircular failed"));
  }

  /** Set motors ON or OFF. Requires appropriate user grant on real controllers. */
  async setMotors(state: "ON" | "OFF"): Promise<void> {
    this._ensureConnected();
    const r = await this.bridge.setMotors(state);
    if (!r.success) throw new Error(String(r.error ?? "setMotors failed"));
  }


  /** Get event log category summaries (categories 0-5). */
  async getEventLogCategories(): Promise<any> {
    this._ensureConnected();
    return this.bridge.getEventLogCategories();
  }

  /** Read a RAPID variable value from a task/module. */
  async getRapidVariable(taskName: string, varName: string, moduleName: string = ""): Promise<any> {
    this._ensureConnected();
    return this.bridge.getRapidVariable(taskName, varName, moduleName);
  }

  /** Write a RAPID variable value to a task/module. */
  async setRapidVariable(taskName: string, moduleName: string, varName: string, value: string): Promise<any> {
    this._ensureConnected();
    return this.bridge.setRapidVariable(taskName, moduleName, varName, value);
  }

  /** List IO signals from the controller IOSystem. */
  async getIOSignals(nameFilter: string = "", limit: number = 100): Promise<any> {
    this._ensureConnected();
    return this.bridge.getIOSignals(nameFilter, limit);
  }

  /** List RAPID module names in a task. */
  async listRapidVariables(taskName: string = "T_ROB1", moduleName: string = "", limit: number = 50): Promise<any> {
    this._ensureConnected();
    return this.bridge.listRapidVariables(taskName, moduleName, limit);
  }

  // ── RAPID code generation helpers ─────────────────────────────────────────

  /**
   * Generate a RAPID MODULE containing a single MoveAbsJ to the given joints.
   * Speed is expressed as a speeddata literal to avoid invalid predefined names.
   */
  generateRapidMoveJoints(
    joints: number[],
    speed: number = 100,
    zone: string = "fine"
  ): string {
    const jointsStr = joints.map(j => j.toFixed(4)).join(", ");
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
  generateRapidSequence(
    positions: Array<{ joints: number[]; speed?: number; zone?: string }>,
    moduleName: string = "OpenClawMotionMod"
  ): string {
    const declarations: string[] = [];
    const moves: string[] = [
      "    ConfJ \\Off;",
      "    ConfL \\Off;",
    ];
    positions.forEach((pos, i) => {
      const jointsStr = pos.joints.map(j => j.toFixed(4)).join(", ");
      const speed = pos.speed ?? 100;
      const zone = pos.zone ?? (i === positions.length - 1 ? "fine" : "z10");
      declarations.push(
        `    VAR jointtarget p${i} := [[${jointsStr}],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];`
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

  isConnected(): boolean {
    return this._connected;
  }

  getSystemName(): string {
    return this._systemName;
  }

  private _ensureConnected(): void {
    if (!this._connected) {
      throw new Error("Not connected to controller. Call connect() first.");
    }
  }

  private _formatSpeedData(speed: number): string {
    const tcp = Math.max(1, Math.min(7000, Number(speed) || 100));
    return `[${tcp.toFixed(3).replace(/\.?0+$/, "")},500,5000,1000]`;
  }
}

/** Create and return a new ABBController instance. */
export function createController(config: ControllerConfig): ABBController {
  return new ABBController(config);
}
