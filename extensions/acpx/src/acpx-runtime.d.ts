declare module "acpx/dist/runtime.js" {
  import type {
    AcpRuntimeCapabilities,
    AcpRuntimeDoctorReport,
    AcpRuntimeEvent,
    AcpRuntimeHandle,
    AcpRuntimeStatus,
  } from "../../../src/acp/runtime/types.js";

  export const ACPX_BACKEND_ID: string;
  export type { AcpRuntimeDoctorReport, AcpRuntimeEvent, AcpRuntimeHandle, AcpRuntimeStatus };

  export type AcpSessionRecord = {
    name?: string;
    [key: string]: unknown;
  };

  export type AcpSessionStore = {
    load: (sessionId: string) => Promise<AcpSessionRecord | undefined>;
    save: (record: AcpSessionRecord) => Promise<void>;
  };

  export type AcpAgentRegistry = {
    resolve: (agentId: string) => string;
    list: () => string[];
  };

  export type AcpRuntimeOptions = {
    cwd: string;
    sessionStore: AcpSessionStore;
    agentRegistry: AcpAgentRegistry;
    permissionMode?: string;
    [key: string]: unknown;
  };

  export class AcpxRuntime {
    constructor(options: AcpRuntimeOptions, testOptions?: unknown);
    isHealthy(): boolean;
    probeAvailability(): Promise<void>;
    doctor(): Promise<AcpRuntimeDoctorReport>;
    ensureSession(input: unknown): Promise<AcpRuntimeHandle>;
    runTurn(input: unknown): AsyncIterable<AcpRuntimeEvent>;
    getCapabilities(input?: { handle?: AcpRuntimeHandle }): AcpRuntimeCapabilities;
    getStatus(input: unknown): Promise<AcpRuntimeStatus>;
    setMode(input: unknown): Promise<void>;
    setConfigOption(input: unknown): Promise<void>;
    cancel(input: unknown): Promise<void>;
    close(input: unknown): Promise<void>;
  }

  export function createAcpRuntime(...args: unknown[]): AcpxRuntime;
  export function createAgentRegistry(...args: unknown[]): AcpAgentRegistry;
  export function createFileSessionStore(...args: unknown[]): AcpSessionStore;
  export function decodeAcpxRuntimeHandleState(...args: unknown[]): unknown;
  export function encodeAcpxRuntimeHandleState(...args: unknown[]): unknown;
}
