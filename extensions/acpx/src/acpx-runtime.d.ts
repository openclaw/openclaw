declare module "acpx/runtime" {
  export const ACPX_BACKEND_ID: string;

  export type AcpRuntimeDoctorReport =
    import("../../../src/acp/runtime/types.js").AcpRuntimeDoctorReport;
  export type AcpRuntimeEnsureInput =
    import("../../../src/acp/runtime/types.js").AcpRuntimeEnsureInput;
  export type AcpRuntimeEvent = import("../../../src/acp/runtime/types.js").AcpRuntimeEvent;
  export type AcpRuntimeHandle = import("../../../src/acp/runtime/types.js").AcpRuntimeHandle;
  export type AcpRuntimeTurnInput = import("../../../src/acp/runtime/types.js").AcpRuntimeTurnInput;
  export type AcpRuntimeStatus = import("../../../src/acp/runtime/types.js").AcpRuntimeStatus;
  export type AcpRuntimeCapabilities =
    import("../../../src/acp/runtime/types.js").AcpRuntimeCapabilities;

  export type AcpSessionStore = {
    load(sessionId: string): Promise<unknown>;
    save(record: unknown): Promise<void>;
  };

  export type AcpAgentRegistry = {
    resolve(agentId: string): string;
    list(): string[];
  };

  export type AcpRuntimeOptions = {
    cwd: string;
    sessionStore: AcpSessionStore;
    agentRegistry: AcpAgentRegistry;
    permissionMode: string;
    mcpServers?: unknown[];
    nonInteractivePermissions?: unknown;
    timeoutMs?: number;
  };

  export class AcpxRuntime {
    constructor(options: AcpRuntimeOptions, testOptions?: unknown);
    isHealthy(): boolean;
    probeAvailability(): Promise<void>;
    doctor(): Promise<AcpRuntimeDoctorReport>;
    ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
    runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;
    getCapabilities(input?: { handle?: AcpRuntimeHandle }): AcpRuntimeCapabilities;
    getStatus(input: { handle: AcpRuntimeHandle; signal?: AbortSignal }): Promise<AcpRuntimeStatus>;
    setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void>;
    setConfigOption(input: { handle: AcpRuntimeHandle; key: string; value: string }): Promise<void>;
    cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void>;
    close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void>;
  }

  export function createAcpRuntime(...args: unknown[]): unknown;
  export function createAgentRegistry(...args: unknown[]): AcpAgentRegistry;
  export function createFileSessionStore(...args: unknown[]): AcpSessionStore;
  export function decodeAcpxRuntimeHandleState(...args: unknown[]): unknown;
  export function encodeAcpxRuntimeHandleState(...args: unknown[]): unknown;
}
