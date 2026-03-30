/**
 * abb-csharp-bridge.ts
 * C# Bridge for ABB Robot Control via PC SDK
 * Uses edge-js to call C# methods in ABBBridge.dll that communicate with real ABB controllers.
 * Exposes ALL public methods defined in ABBBridge.cs.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as edge from "edge-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Result shape returned by most bridge methods
export interface BridgeResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * ABB C# Bridge — thin wrapper around ABBBridge.dll via edge-js.
 * One instance per controller session; call connect() before any other method.
 */
export class ABBCSharpBridge extends EventEmitter {
  private _connected: boolean = false;
  private _systemName: string = "";

  // edge-js function handles (initialised lazily)
  private fn: Record<string, any> = {};

  constructor() {
    super();
    this._initBridge();
  }

  // ── Init ─────────────────────────────────────────────────────────────────────────────

  private _initBridge(): void {
    const dllCandidates = [
      path.join(__dirname, "ABBBridge.dll"),
      path.join(__dirname, "src", "ABBBridge.dll"),
    ];
    const dllPath = dllCandidates.find((candidate) => fs.existsSync(candidate)) ?? dllCandidates[0];
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
      } catch {
        // DLL not present at init time — errors surface at call time
      }
    }
  }

  private _call<T = BridgeResult>(methodName: string, payload: unknown): Promise<T> {
    const fn = this.fn[methodName];
    if (!fn)
      return Promise.reject(
        new Error(`C# bridge method '${methodName}' not initialised — is ABBBridge.dll present?`),
      );
    return new Promise<T>((resolve, reject) => {
      fn(payload, (err: Error | null, result: T) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  // ── Connection ─────────────────────────────────────────────────────────────────────

  async connect(host: string): Promise<BridgeResult> {
    const result = await this._call<BridgeResult>("Connect", { host });
    if (result.success) {
      this._connected = true;
      this._systemName = String(result.systemName ?? "");
      this.emit("connected", result);
    }
    return result;
  }

  async disconnect(): Promise<BridgeResult> {
    const result = await this._call<BridgeResult>("Disconnect", {});
    if (result.success) {
      this._connected = false;
      this.emit("disconnected");
    }
    return result;
  }

  // ── Discovery ────────────────────────────────────────────────────────────────────

  async scanControllers(): Promise<BridgeResult> {
    return this._call("ScanControllers", {});
  }

  // ── Status & Info ──────────────────────────────────────────────────────────────────

  async getStatus(): Promise<BridgeResult> {
    return this._call("GetStatus", {});
  }

  async getSystemInfo(): Promise<BridgeResult> {
    return this._call("GetSystemInfo", {});
  }

  async getServiceInfo(): Promise<BridgeResult> {
    return this._call("GetServiceInfo", {});
  }

  // ── Speed ──────────────────────────────────────────────────────────────────────────

  async getSpeedRatio(): Promise<BridgeResult> {
    return this._call("GetSpeedRatio", {});
  }

  async setSpeedRatio(speed: number): Promise<BridgeResult> {
    return this._call("SetSpeedRatio", { speed });
  }

  // ── Position ───────────────────────────────────────────────────────────────────────

  async getJointPositions(): Promise<number[]> {
    const result = await this._call<BridgeResult>("GetJointPositions", {});
    if (!result.success) throw new Error(String(result.error ?? "GetJointPositions failed"));
    return result.joints as number[];
  }

  async getWorldPosition(): Promise<BridgeResult> {
    return this._call("GetWorldPosition", {});
  }

  // ── Event Log ──────────────────────────────────────────────────────────────────────

  async getEventLogEntries(categoryId: number = 0, limit: number = 20): Promise<BridgeResult> {
    return this._call("GetEventLogEntries", { categoryId, limit });
  }

  // ── Tasks & Modules ──────────────────────────────────────────────────────────────────

  async listTasks(): Promise<BridgeResult> {
    return this._call("ListTasks", {});
  }

  async backupModule(
    moduleName: string,
    taskName: string,
    outputDir: string,
  ): Promise<BridgeResult> {
    return this._call("BackupModule", { moduleName, taskName, outputDir });
  }

  async resetProgramPointer(
    taskName: string = "T_ROB1",
    moduleName?: string,
    routineName?: string,
  ): Promise<BridgeResult> {
    return this._call("ResetProgramPointer", { taskName, moduleName, routineName });
  }

  // ── RAPID ─────────────────────────────────────────────────────────────────────────────

  async loadRapidProgram(code: string, allowRealExecution: boolean = false): Promise<BridgeResult> {
    return this._call("LoadRapidProgram", { code, allowRealExecution });
  }

  async startRapid(allowRealExecution: boolean = true): Promise<BridgeResult> {
    return this._call("StartRapid", { allowRealExecution });
  }

  async stopRapid(): Promise<BridgeResult> {
    return this._call("StopRapid", {});
  }

  // ── Motion ───────────────────────────────────────────────────────────────────────────

  async moveToJoints(
    joints: number[],
    speed: number = 100,
    zone: string = "fine",
  ): Promise<BridgeResult> {
    return this._call("MoveToJoints", { joints, speed, zone });
  }

  async moveLinear(
    x: number,
    y: number,
    z: number,
    rx: number,
    ry: number,
    rz: number,
    speed: number = 100,
    zone: string = "fine",
  ): Promise<BridgeResult> {
    return this._call("MoveLinear", { x, y, z, rx, ry, rz, speed, zone });
  }

  async moveCircular(
    circPoint: number[],
    toPoint: number[],
    speed: number = 100,
    zone: string = "fine",
  ): Promise<BridgeResult> {
    return this._call("MoveCircular", { circPoint, toPoint, speed, zone });
  }

  /**
   * High-level: load + reset pointer + start + wait for completion.
   * Maps to C# ExecuteRapidProgram which calls ExecuteRapidProgramWait internally.
   */
  async executeRapidProgram(
    code: string,
    moduleName: string = "OpenClawMotionMod",
    allowRealExecution: boolean = true,
  ): Promise<BridgeResult> {
    return this._call("ExecuteRapidProgram", { code, moduleName, allowRealExecution });
  }

  /**
   * Set motors ON or OFF.
   * Note: may fail on real controllers with DefaultUser credentials.
   */
  async setMotors(state: "ON" | "OFF"): Promise<BridgeResult> {
    return this._call("SetMotors", { state });
  }

  // ── IO & RAPID Variables ──────────────────────────────────────────────────────────────────────

  async getEventLogCategories(): Promise<BridgeResult> {
    return this._call("GetEventLogCategories", {});
  }

  async getRapidVariable(
    taskName: string,
    varName: string,
    moduleName: string = "",
  ): Promise<BridgeResult> {
    return this._call("GetRapidVariable", { taskName, varName, moduleName });
  }

  async setRapidVariable(
    taskName: string,
    moduleName: string,
    varName: string,
    value: string,
  ): Promise<BridgeResult> {
    return this._call("SetRapidVariable", { taskName, moduleName, varName, value });
  }

  async getIOSignals(nameFilter: string = "", limit: number = 100): Promise<BridgeResult> {
    return this._call("GetIOSignals", { nameFilter, limit });
  }

  async listRapidVariables(
    taskName: string = "T_ROB1",
    moduleName: string = "",
    limit: number = 50,
  ): Promise<BridgeResult> {
    return this._call("ListRapidVariables", { taskName, moduleName, limit });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────

  isConnected(): boolean {
    return this._connected;
  }

  getSystemName(): string {
    return this._systemName;
  }
}

export function createCSharpBridge(): ABBCSharpBridge {
  return new ABBCSharpBridge();
}
