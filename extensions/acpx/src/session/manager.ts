import path from "node:path";
import type {
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnAttachment,
} from "../../runtime-api.js";
import { resolveAgentCommand } from "../agents/registry.js";
import type { ResolvedAcpxPluginConfig } from "../config.js";
import { normalizeOutputError } from "../error-normalization.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  createSessionConversation,
  recordClientOperation,
  recordPromptSubmission,
  recordSessionUpdate,
  trimConversationForRuntime,
} from "../history/conversation.js";
import { parsePromptEventLine } from "../history/projector.js";
import { textPrompt, type PromptInput } from "../prompt-content.js";
import type {
  ClientOperation,
  McpServer,
  SessionAcpxState,
  SessionConversation,
  SessionRecord,
  SessionResumePolicy,
} from "../runtime-types.js";
import { withTimeout } from "../session-runtime-helpers.js";
import { AcpClient } from "../transport/acp-client.js";
import {
  applyConversation,
  applyLifecycleSnapshotToRecord,
  reconcileAgentSessionId,
} from "./lifecycle.js";
import { connectAndLoadSession } from "./reconnect.js";
import { SessionRepository, SESSION_RECORD_SCHEMA } from "./repository.js";
import { shouldReuseExistingRecord } from "./reuse-policy.js";

type ActiveSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionConfigOption: (configId: string, value: string) => Promise<void>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class AsyncEventQueue {
  private readonly items: AcpRuntimeEvent[] = [];
  private readonly waits: Deferred<AcpRuntimeEvent | null>[] = [];
  private closed = false;

  push(item: AcpRuntimeEvent): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waits.shift();
    if (waiter) {
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waits.splice(0)) {
      waiter.resolve(null);
    }
  }

  async next(): Promise<AcpRuntimeEvent | null> {
    if (this.items.length > 0) {
      return this.items.shift() ?? null;
    }
    if (this.closed) {
      return null;
    }
    const waiter = createDeferred<AcpRuntimeEvent | null>();
    this.waits.push(waiter);
    return await waiter.promise;
  }

  async *iterate(): AsyncIterable<AcpRuntimeEvent> {
    while (true) {
      const next = await this.next();
      if (!next) {
        return;
      }
      yield next;
    }
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function toPromptInput(
  text: string,
  attachments?: AcpRuntimeTurnAttachment[],
): PromptInput | string {
  if (!attachments || attachments.length === 0) {
    return text;
  }
  const blocks: Array<
    { type: "text"; text: string } | { type: "image"; mimeType: string; data: string }
  > = [];
  if (text) {
    blocks.push({ type: "text", text });
  }
  for (const attachment of attachments) {
    if (attachment.mediaType.startsWith("image/")) {
      blocks.push({
        type: "image",
        mimeType: attachment.mediaType,
        data: attachment.data,
      });
    }
  }
  return blocks.length > 0 ? blocks : textPrompt(text);
}

function toSdkMcpServers(config: ResolvedAcpxPluginConfig): McpServer[] {
  return Object.entries(config.mcpServers).map(([name, server]) => ({
    name,
    command: server.command,
    args: [...(server.args ?? [])],
    env: Object.entries(server.env ?? {}).map(([envName, value]) => ({
      name: envName,
      value,
    })),
  }));
}

function createInitialRecord(params: {
  sessionKey: string;
  sessionId: string;
  agentCommand: string;
  cwd: string;
  agentSessionId?: string;
}): SessionRecord {
  const now = isoNow();
  return {
    schema: SESSION_RECORD_SCHEMA,
    acpxRecordId: params.sessionKey,
    acpSessionId: params.sessionId,
    agentSessionId: params.agentSessionId,
    agentCommand: params.agentCommand,
    cwd: params.cwd,
    name: params.sessionKey,
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    eventLog: {
      active_path: "",
      segment_count: 0,
      max_segment_bytes: 0,
      max_segments: 0,
      last_write_at: undefined,
      last_write_error: null,
    },
    closed: false,
    closedAt: undefined,
    ...createSessionConversation(now),
    acpx: {},
  };
}

function statusSummary(record: SessionRecord): string {
  const parts = [
    `session=${record.acpxRecordId}`,
    `backendSessionId=${record.acpSessionId}`,
    record.agentSessionId ? `agentSessionId=${record.agentSessionId}` : null,
    record.pid != null ? `pid=${record.pid}` : null,
    record.closed ? "closed" : "open",
  ].filter(Boolean);
  return parts.join(" ");
}

export class SessionRuntimeManager {
  private readonly repository: SessionRepository;
  private readonly activeControllers = new Map<string, ActiveSessionController>();

  constructor(private readonly config: ResolvedAcpxPluginConfig) {
    this.repository = new SessionRepository(config);
  }

  async ensureSession(input: {
    sessionKey: string;
    agent: string;
    cwd?: string;
    resumeSessionId?: string;
  }): Promise<SessionRecord> {
    const cwd = path.resolve(input.cwd?.trim() || this.config.cwd);
    const agentCommand = resolveAgentCommand(input.agent, this.config.agents);
    const existing = await this.repository.load(input.sessionKey);
    if (
      existing &&
      shouldReuseExistingRecord(existing, {
        cwd,
        agentCommand,
        resumeSessionId: input.resumeSessionId,
      })
    ) {
      existing.closed = false;
      existing.closedAt = undefined;
      await this.repository.save(existing);
      return existing;
    }

    const client = new AcpClient({
      agentCommand,
      cwd,
      mcpServers: toSdkMcpServers(this.config),
      permissionMode: this.config.permissionMode,
      nonInteractivePermissions: this.config.nonInteractivePermissions,
      verbose: false,
    });

    try {
      await client.start();
      let sessionId: string;
      let agentSessionId: string | undefined;
      if (input.resumeSessionId) {
        const loaded = await client.loadSession(input.resumeSessionId, cwd);
        sessionId = input.resumeSessionId;
        agentSessionId = loaded.agentSessionId;
      } else {
        const created = await client.createSession(cwd);
        sessionId = created.sessionId;
        agentSessionId = created.agentSessionId;
      }
      const record = createInitialRecord({
        sessionKey: input.sessionKey,
        sessionId,
        agentCommand,
        cwd,
        agentSessionId,
      });
      record.protocolVersion = client.initializeResult?.protocolVersion;
      record.agentCapabilities = client.initializeResult?.agentCapabilities;
      applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
      await this.repository.save(record);
      return record;
    } finally {
      await client.close();
    }
  }

  async *runTurn(input: {
    handle: AcpRuntimeHandle;
    text: string;
    attachments?: AcpRuntimeTurnAttachment[];
    requestId: string;
    signal?: AbortSignal;
  }): AsyncIterable<AcpRuntimeEvent> {
    const record = await this.requireRecord(input.handle.acpxRecordId ?? input.handle.sessionKey);
    const conversation = cloneSessionConversation(record);
    let acpxState = cloneSessionAcpxState(record.acpx);
    recordPromptSubmission(conversation, toPromptInput(input.text, input.attachments), isoNow());
    trimConversationForRuntime(conversation);

    const queue = new AsyncEventQueue();
    const client = new AcpClient({
      agentCommand: record.agentCommand,
      cwd: record.cwd,
      mcpServers: toSdkMcpServers(this.config),
      permissionMode: this.config.permissionMode,
      nonInteractivePermissions: this.config.nonInteractivePermissions,
      verbose: false,
    });
    let activeSessionId = record.acpSessionId;
    let sawDone = false;
    const activeController: ActiveSessionController = {
      hasActivePrompt: () => client.hasActivePrompt(),
      requestCancelActivePrompt: async () => await client.requestCancelActivePrompt(),
      setSessionMode: async (modeId: string) => {
        await client.setSessionMode(activeSessionId, modeId);
      },
      setSessionConfigOption: async (configId: string, value: string) => {
        await client.setSessionConfigOption(activeSessionId, configId, value);
      },
    };

    const emitParsed = (payload: Record<string, unknown>): void => {
      const parsed = parsePromptEventLine(JSON.stringify(payload));
      if (!parsed) {
        return;
      }
      if (parsed.type === "done") {
        sawDone = true;
      }
      queue.push(parsed);
    };

    const abortHandler = () => {
      void activeController.requestCancelActivePrompt();
    };
    if (input.signal) {
      if (input.signal.aborted) {
        queue.close();
        return;
      }
      input.signal.addEventListener("abort", abortHandler, { once: true });
    }

    this.activeControllers.set(record.acpxRecordId, activeController);

    void (async () => {
      try {
        client.setEventHandlers({
          onSessionUpdate: (notification) => {
            acpxState = recordSessionUpdate(conversation, acpxState, notification);
            trimConversationForRuntime(conversation);
            emitParsed({
              jsonrpc: "2.0",
              method: "session/update",
              params: notification,
            });
          },
          onClientOperation: (operation: ClientOperation) => {
            acpxState = recordClientOperation(conversation, acpxState, operation);
            trimConversationForRuntime(conversation);
            emitParsed({
              type: "client_operation",
              ...operation,
            });
          },
        });

        const { sessionId, resumed, loadError } = await connectAndLoadSession({
          client,
          record,
          resumePolicy: "allow-new" satisfies SessionResumePolicy,
          timeoutMs: this.timeoutMs,
          activeController,
          onClientAvailable: (controller) => {
            this.activeControllers.set(record.acpxRecordId, controller);
          },
          onConnectedRecord: (connectedRecord) => {
            connectedRecord.lastPromptAt = isoNow();
          },
          onSessionIdResolved: (sessionIdValue) => {
            activeSessionId = sessionIdValue;
          },
        });

        record.lastRequestId = input.requestId;
        record.lastPromptAt = isoNow();
        record.closed = false;
        record.closedAt = undefined;
        record.lastUsedAt = isoNow();
        if (resumed || loadError) {
          emitParsed({
            type: "status",
            text: loadError ? `load fallback: ${loadError}` : "session resumed",
          });
        }

        const response = await withTimeout(
          client.prompt(sessionId, toPromptInput(input.text, input.attachments)),
          this.timeoutMs,
        );

        record.acpSessionId = activeSessionId;
        reconcileAgentSessionId(record, record.agentSessionId);
        record.protocolVersion = client.initializeResult?.protocolVersion;
        record.agentCapabilities = client.initializeResult?.agentCapabilities;
        record.acpx = acpxState;
        applyConversation(record, conversation);
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        await this.repository.save(record);

        if (!sawDone) {
          queue.push({
            type: "done",
            stopReason: response.stopReason,
          });
        }
      } catch (error) {
        const normalized = normalizeOutputError(error, { origin: "runtime" });
        queue.push({
          type: "error",
          message: normalized.message,
          code: normalized.code,
          retryable: normalized.retryable,
        });
      } finally {
        if (input.signal) {
          input.signal.removeEventListener("abort", abortHandler);
        }
        this.activeControllers.delete(record.acpxRecordId);
        client.clearEventHandlers();
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.acpx = acpxState;
        applyConversation(record, conversation);
        record.lastUsedAt = isoNow();
        await this.repository.save(record).catch(() => {});
        await client.close().catch(() => {});
        queue.close();
      }
    })();

    yield* queue.iterate();
  }

  async getStatus(handle: AcpRuntimeHandle): Promise<AcpRuntimeStatus> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    return {
      summary: statusSummary(record),
      acpxRecordId: record.acpxRecordId,
      backendSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      details: {
        cwd: record.cwd,
        lastUsedAt: record.lastUsedAt,
        closed: record.closed === true,
      },
    };
  }

  async setMode(handle: AcpRuntimeHandle, mode: string): Promise<void> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    const controller = this.activeControllers.get(record.acpxRecordId);
    if (controller) {
      await controller.setSessionMode(mode);
    } else {
      const client = new AcpClient({
        agentCommand: record.agentCommand,
        cwd: record.cwd,
        mcpServers: toSdkMcpServers(this.config),
        permissionMode: this.config.permissionMode,
        nonInteractivePermissions: this.config.nonInteractivePermissions,
        verbose: false,
      });
      try {
        await client.start();
        const { sessionId } = await connectAndLoadSession({
          client,
          record,
          timeoutMs: this.timeoutMs,
          activeController: {
            hasActivePrompt: () => false,
            requestCancelActivePrompt: async () => false,
            setSessionMode: async () => {},
            setSessionConfigOption: async () => {},
          },
        });
        await client.setSessionMode(sessionId, mode);
      } finally {
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        await this.repository.save(record).catch(() => {});
        await client.close();
      }
    }
    record.acpx = {
      ...(record.acpx ?? ({} as SessionAcpxState)),
      desired_mode_id: mode,
    };
    await this.repository.save(record);
  }

  async setConfigOption(handle: AcpRuntimeHandle, key: string, value: string): Promise<void> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    const controller = this.activeControllers.get(record.acpxRecordId);
    if (controller) {
      await controller.setSessionConfigOption(key, value);
    } else {
      const client = new AcpClient({
        agentCommand: record.agentCommand,
        cwd: record.cwd,
        mcpServers: toSdkMcpServers(this.config),
        permissionMode: this.config.permissionMode,
        nonInteractivePermissions: this.config.nonInteractivePermissions,
        verbose: false,
      });
      try {
        await client.start();
        const { sessionId } = await connectAndLoadSession({
          client,
          record,
          timeoutMs: this.timeoutMs,
          activeController: {
            hasActivePrompt: () => false,
            requestCancelActivePrompt: async () => false,
            setSessionMode: async () => {},
            setSessionConfigOption: async () => {},
          },
        });
        await client.setSessionConfigOption(sessionId, key, value);
      } finally {
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        await this.repository.save(record).catch(() => {});
        await client.close();
      }
    }
    await this.repository.save(record);
  }

  async cancel(handle: AcpRuntimeHandle): Promise<void> {
    const controller = this.activeControllers.get(handle.acpxRecordId ?? handle.sessionKey);
    await controller?.requestCancelActivePrompt();
  }

  async close(handle: AcpRuntimeHandle): Promise<void> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    await this.cancel(handle);
    record.closed = true;
    record.closedAt = isoNow();
    await this.repository.save(record);
  }

  private get timeoutMs(): number | undefined {
    return this.config.timeoutSeconds != null ? this.config.timeoutSeconds * 1_000 : undefined;
  }

  private async requireRecord(sessionId: string): Promise<SessionRecord> {
    const record = await this.repository.load(sessionId);
    if (!record) {
      throw new Error(`ACP session not found: ${sessionId}`);
    }
    return record;
  }
}
