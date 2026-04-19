import {
  ACPX_BACKEND_ID,
  AcpxRuntime as BaseAcpxRuntime,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
  type AcpAgentRegistry,
  type AcpRuntimeDoctorReport,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
} from "acpx/runtime";
import type { AcpRuntime } from "../runtime-api.js";

type AcpSessionStore = AcpRuntimeOptions["sessionStore"];
type AcpSessionRecord = Parameters<AcpSessionStore["save"]>[0];
type AcpLoadedSessionRecord = Awaited<ReturnType<AcpSessionStore["load"]>>;

type ResetAwareSessionStore = AcpSessionStore & {
  markFresh: (sessionKey: string) => void;
};

function readSessionRecordName(record: AcpSessionRecord): string {
  if (typeof record !== "object" || record === null) {
    return "";
  }
  const { name } = record as { name?: unknown };
  return typeof name === "string" ? name.trim() : "";
}

function createResetAwareSessionStore(baseStore: AcpSessionStore): ResetAwareSessionStore {
  const freshSessionKeys = new Set<string>();

  return {
    async load(sessionId: string): Promise<AcpLoadedSessionRecord> {
      const normalized = sessionId.trim();
      if (normalized && freshSessionKeys.has(normalized)) {
        return undefined;
      }
      return await baseStore.load(sessionId);
    },
    async save(record: AcpSessionRecord): Promise<void> {
      await baseStore.save(record);
      const sessionName = readSessionRecordName(record);
      if (sessionName) {
        freshSessionKeys.delete(sessionName);
      }
    },
    markFresh(sessionKey: string): void {
      const normalized = sessionKey.trim();
      if (normalized) {
        freshSessionKeys.add(normalized);
      }
    },
  };
}

const OPENCLAW_BRIDGE_COMMAND = "openclaw acp";

function normalizeAgentName(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function readAgentFromSessionKey(sessionKey: string | undefined): string | undefined {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    return undefined;
  }
  const match = /^agent:(?<agent>[^:]+):/i.exec(normalized);
  return normalizeAgentName(match?.groups?.agent);
}

function readAgentFromHandle(handle: AcpRuntimeHandle): string | undefined {
  const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
  if (typeof decoded === "object" && decoded !== null) {
    const { agent } = decoded as { agent?: unknown };
    if (typeof agent === "string") {
      return normalizeAgentName(agent) ?? readAgentFromSessionKey(handle.sessionKey);
    }
  }
  return readAgentFromSessionKey(handle.sessionKey);
}

function resolveAgentCommand(params: {
  agentName: string | undefined;
  agentRegistry: AcpAgentRegistry;
}): string | undefined {
  const normalizedAgentName = normalizeAgentName(params.agentName);
  if (!normalizedAgentName) {
    return undefined;
  }
  const resolvedCommand = params.agentRegistry.resolve(normalizedAgentName);
  return typeof resolvedCommand === "string" ? resolvedCommand.trim() || undefined : undefined;
}

function shouldUseBridgeSafeDelegate(params: {
  agentName: string | undefined;
  agentRegistry: AcpAgentRegistry;
}): boolean {
  return resolveAgentCommand(params) === OPENCLAW_BRIDGE_COMMAND;
}

function shouldUseDistinctBridgeDelegate(options: AcpRuntimeOptions): boolean {
  const { mcpServers } = options as { mcpServers?: unknown };
  return Array.isArray(mcpServers) && mcpServers.length > 0;
}

export class AcpxRuntime implements AcpRuntime {
  private readonly sessionStore: ResetAwareSessionStore;
  private readonly agentRegistry: AcpAgentRegistry;
  private readonly delegate: BaseAcpxRuntime;
  private readonly bridgeSafeDelegate: BaseAcpxRuntime;

  constructor(
    options: AcpRuntimeOptions,
    testOptions?: ConstructorParameters<typeof BaseAcpxRuntime>[1],
  ) {
    this.sessionStore = createResetAwareSessionStore(options.sessionStore);
    this.agentRegistry = options.agentRegistry;
    const sharedOptions = {
      ...options,
      sessionStore: this.sessionStore,
    };
    this.delegate = new BaseAcpxRuntime(sharedOptions, testOptions);
    this.bridgeSafeDelegate = shouldUseDistinctBridgeDelegate(options)
      ? new BaseAcpxRuntime(
          {
            ...sharedOptions,
            mcpServers: [],
          },
          testOptions,
        )
      : this.delegate;
  }

  private resolveDelegateForAgent(agentName: string | undefined): BaseAcpxRuntime {
    return shouldUseBridgeSafeDelegate({
      agentName,
      agentRegistry: this.agentRegistry,
    })
      ? this.bridgeSafeDelegate
      : this.delegate;
  }

  private resolveDelegateForHandle(handle: AcpRuntimeHandle): BaseAcpxRuntime {
    return this.resolveDelegateForAgent(readAgentFromHandle(handle));
  }

  isHealthy(): boolean {
    return this.delegate.isHealthy();
  }

  probeAvailability(): Promise<void> {
    return this.delegate.probeAvailability();
  }

  doctor(): Promise<AcpRuntimeDoctorReport> {
    return this.delegate.doctor();
  }

  ensureSession(input: Parameters<AcpRuntime["ensureSession"]>[0]): Promise<AcpRuntimeHandle> {
    return this.resolveDelegateForAgent(input.agent).ensureSession(input);
  }

  runTurn(input: Parameters<AcpRuntime["runTurn"]>[0]): AsyncIterable<AcpRuntimeEvent> {
    return this.resolveDelegateForHandle(input.handle).runTurn(input);
  }

  getCapabilities(): ReturnType<BaseAcpxRuntime["getCapabilities"]> {
    return this.delegate.getCapabilities();
  }

  getStatus(input: Parameters<NonNullable<AcpRuntime["getStatus"]>>[0]): Promise<AcpRuntimeStatus> {
    return this.resolveDelegateForHandle(input.handle).getStatus(input);
  }

  setMode(input: Parameters<NonNullable<AcpRuntime["setMode"]>>[0]): Promise<void> {
    return this.resolveDelegateForHandle(input.handle).setMode(input);
  }

  setConfigOption(input: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0]): Promise<void> {
    return this.resolveDelegateForHandle(input.handle).setConfigOption(input);
  }

  cancel(input: Parameters<AcpRuntime["cancel"]>[0]): Promise<void> {
    return this.resolveDelegateForHandle(input.handle).cancel(input);
  }

  async prepareFreshSession(input: { sessionKey: string }): Promise<void> {
    this.sessionStore.markFresh(input.sessionKey);
  }

  close(input: Parameters<AcpRuntime["close"]>[0]): Promise<void> {
    return this.resolveDelegateForHandle(input.handle)
      .close({
        handle: input.handle,
        reason: input.reason,
        discardPersistentState: input.discardPersistentState,
      })
      .then(() => {
        if (input.discardPersistentState) {
          this.sessionStore.markFresh(input.handle.sessionKey);
        }
      });
  }
}

export {
  ACPX_BACKEND_ID,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
};

export type { AcpAgentRegistry, AcpRuntimeOptions, AcpSessionRecord, AcpSessionStore };
