import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  ConnectorConfig,
  ConnectorInboundMessage,
  ConnectorOutboundMessage,
  ConnectorStatus,
} from "./types.js";

export type ConnectorEventHandler = (event: {
  connectorId: string;
  type: string;
  source: string;
  payload: Record<string, unknown>;
  correlationId?: string;
}) => void | Promise<void>;

type ConnectorInstance = {
  id: string;
  config: ConnectorConfig;
  proc: ChildProcessWithoutNullStreams;
  ready: boolean;
  lastError?: string;
};

type PendingInvoke = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const INVOKE_TIMEOUT_MS = 10_000;

export class ConnectorManager {
  private readonly connectors = new Map<string, ConnectorInstance>();
  private readonly pendingInvokes = new Map<string, PendingInvoke>();
  private onEvent?: ConnectorEventHandler;
  private readonly logger?: (msg: string) => void;

  constructor(opts?: { onEvent?: ConnectorEventHandler; logger?: (msg: string) => void }) {
    this.onEvent = opts?.onEvent;
    this.logger = opts?.logger;
  }

  setEventHandler(handler: ConnectorEventHandler | undefined): void {
    this.onEvent = handler;
  }

  async start(connectorId: string, config: ConnectorConfig): Promise<void> {
    if (config.enabled === false) {
      return;
    }
    await this.stop(connectorId);

    const proc = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: { ...process.env, ...config.env, CLAWORKS_CONNECTOR_ID: connectorId },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const instance: ConnectorInstance = {
      id: connectorId,
      config,
      proc,
      ready: false,
    };
    this.connectors.set(connectorId, instance);

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      this.handleLine(connectorId, line);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.logger?.(`[connector:${connectorId}:stderr] ${text}`);
      }
    });

    proc.on("exit", (code) => {
      instance.ready = false;
      if (code !== 0 && code !== null) {
        instance.lastError = `exited with code ${code}`;
        this.logger?.(`[connector:${connectorId}] ${instance.lastError}`);
      }
      for (const [id, pending] of this.pendingInvokes) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`connector ${connectorId} exited`));
        this.pendingInvokes.delete(id);
      }
    });
  }

  async stop(connectorId: string): Promise<void> {
    const instance = this.connectors.get(connectorId);
    if (!instance) {
      return;
    }
    this.send(instance, { type: "shutdown" });
    instance.proc.kill("SIGTERM");
    this.connectors.delete(connectorId);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.connectors.keys()]) {
      await this.stop(id);
    }
  }

  async invoke(
    connectorId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const instance = this.connectors.get(connectorId);
    if (!instance) {
      throw new Error(`Connector not running: ${connectorId}`);
    }
    const invokeId = `${connectorId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(invokeId);
        reject(new Error(`connector invoke timed out after ${INVOKE_TIMEOUT_MS}ms`));
      }, INVOKE_TIMEOUT_MS);
      this.pendingInvokes.set(invokeId, { resolve, reject, timer });
      this.send(instance, {
        type: "invoke",
        id: invokeId,
        method,
        params,
      });
    });
  }

  list(): ConnectorStatus[] {
    return [...this.connectors.values()].map((c) => ({
      id: c.id,
      running: !c.proc.killed,
      pid: c.proc.pid,
      ready: c.ready,
      lastError: c.lastError,
    }));
  }

  private send(instance: ConnectorInstance, msg: ConnectorOutboundMessage): void {
    instance.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private handleLine(connectorId: string, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let msg: ConnectorInboundMessage;
    try {
      msg = JSON.parse(trimmed) as ConnectorInboundMessage;
    } catch {
      this.logger?.(`[connector:${connectorId}] invalid JSON: ${trimmed.slice(0, 120)}`);
      return;
    }

    const instance = this.connectors.get(connectorId);
    if (!instance) {
      return;
    }

    if (msg.type === "ready") {
      instance.ready = true;
      this.logger?.(`[connector:${connectorId}] ready`);
      return;
    }
    if (msg.type === "log") {
      this.logger?.(`[connector:${connectorId}] ${msg.message}`);
      return;
    }
    if (msg.type === "result") {
      const pending = this.pendingInvokes.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingInvokes.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error ?? "connector invoke failed"));
        }
      }
      return;
    }
    if (msg.type === "event") {
      void this.onEvent?.({
        connectorId,
        type: msg.event_type,
        source: msg.source || `connector://${connectorId}`,
        payload: msg.payload ?? {},
        correlationId: msg.correlation_id,
      });
    }
  }
}
