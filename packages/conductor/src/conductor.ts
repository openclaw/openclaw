/**
 * Aether Conductor — Main Orchestrator
 *
 * "Operation Ouroboros" — The Closed Loop
 *
 * This is the brain of the conductor. It:
 * 1. Starts the terminal interceptor (wraps Claude Code)
 * 2. Routes terminal output through the analyzer (Gemini/regex)
 * 3. When an external-access request is detected, sends it to the operator
 *    via messaging for authorization
 * 4. On approval, executes browser actions via Aether
 * 5. Injects results back into Claude's terminal
 * 6. Claude continues coding with the new information
 *
 * All external dependencies (analyzer, forwarder, executor) are injected,
 * keeping this package free of hard dependencies on the main app.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ConductorAuthorization,
  ConductorConfig,
  ConductorEvent,
  ConductorEventListener,
  ConductorExecutor,
  ConductorForwarder,
  ConductorHistoryEntry,
  ConductorInjection,
  ConductorSessionState,
  ExternalAccessRequest,
} from "./types.js";
import { createAnalyzer } from "./analyzer.js";
import { injectDenial, injectResults, injectTimeout } from "./injector.js";
import { TerminalInterceptor, generateRequestId } from "./interceptor.js";

export type ConductorOptions = {
  config: ConductorConfig;
  /** Provide a forwarder for messaging integration. Required for auth flow. */
  forwarder?: ConductorForwarder;
  /** Provide a browser executor. Required for browser actions. */
  executor?: ConductorExecutor;
};

/** Stub executor that returns empty results (used when no executor is provided). */
const stubExecutor: ConductorExecutor = {
  async execute() {
    return [];
  },
};

/** Stub forwarder that logs to console (used when no forwarder is provided). */
const stubForwarder: ConductorForwarder = {
  async requestAuthorization(request) {
    console.log(`[conductor] Authorization needed: ${request.summary} (no forwarder configured)`);
  },
  async notifyResult() {},
  onAuthorization() {
    return () => {};
  },
  stop() {},
};

export class Conductor {
  private readonly config: ConductorConfig;
  private readonly interceptor: TerminalInterceptor;
  private readonly analyzer: ReturnType<typeof createAnalyzer>;
  private readonly forwarder: ConductorForwarder;
  private readonly executor: ConductorExecutor;
  private readonly listeners = new Set<ConductorEventListener>();
  private readonly state: ConductorSessionState;
  private forwarderCleanup: (() => void) | null = null;
  private auditStream: fs.WriteStream | null = null;

  constructor(options: ConductorOptions) {
    this.config = options.config;
    this.interceptor = new TerminalInterceptor(options.config);
    this.analyzer = createAnalyzer(options.config.analyzer);
    this.forwarder = options.forwarder ?? stubForwarder;
    this.executor = options.executor ?? stubExecutor;
    this.state = {
      pending: new Map(),
      history: [],
      active: false,
      startedAtMs: 0,
    };

    // Open audit log if enabled
    if (options.config.auditLog !== false) {
      const auditPath = expandHome(
        options.config.auditLogPath ?? "~/.openclaw/conductor-audit.jsonl",
      );
      const dir = path.dirname(auditPath);
      fs.mkdirSync(dir, { recursive: true });
      this.auditStream = fs.createWriteStream(auditPath, { flags: "a" });
    }
  }

  /** Start the conductor — wraps Claude Code and begins the Ouroboros loop. */
  async start(): Promise<void> {
    if (this.state.active) {
      throw new Error("Conductor already running");
    }

    this.state.active = true;
    this.state.startedAtMs = Date.now();

    // Wire up the interceptor -> analyzer pipeline
    this.interceptor.on("flush", (buffered: string) => {
      void this.handleTerminalOutput(buffered);
    });

    this.interceptor.on("exit", (code: number | null, signal: string | null) => {
      this.emit({ type: "stopped", ts: Date.now() });
      this.stop();
    });

    this.interceptor.on("error", (err: Error) => {
      this.emit({ type: "error", message: String(err), ts: Date.now() });
    });

    // Wire up the forwarder -> executor pipeline
    this.forwarderCleanup = this.forwarder.onAuthorization((auth) => {
      void this.handleAuthorization(auth);
    });

    // Start the child process
    this.interceptor.start();
    this.state.childPid = this.interceptor.pid;

    this.emit({ type: "started", pid: this.interceptor.pid, ts: Date.now() });
    this.audit({ event: "started", pid: this.interceptor.pid });
  }

  /** Stop the conductor and all sub-systems. */
  stop(): void {
    this.state.active = false;
    this.interceptor.stop();
    this.forwarder.stop();
    if (this.forwarderCleanup) {
      this.forwarderCleanup();
      this.forwarderCleanup = null;
    }
    if (this.auditStream) {
      this.auditStream.end();
      this.auditStream = null;
    }
    this.emit({ type: "stopped", ts: Date.now() });
  }

  /** Subscribe to conductor events. */
  on(listener: ConductorEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Get current session state (for status display). */
  getState(): Readonly<ConductorSessionState> {
    return this.state;
  }

  // -------------------------------------------------------------------------
  // Core pipeline
  // -------------------------------------------------------------------------

  private async handleTerminalOutput(text: string): Promise<void> {
    this.emit({ type: "output", text, ts: Date.now() });

    try {
      const result = await this.analyzer.analyze(text);
      const threshold = this.config.analyzer?.confidenceThreshold ?? 0.7;

      if (!result.detected || result.confidence < threshold || !result.request) {
        return;
      }

      // Build the full request object
      const request: ExternalAccessRequest = {
        id: generateRequestId(),
        ...result.request,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + (this.config.auth?.timeoutMs ?? 120_000),
      };

      // Check auto-approve/deny patterns
      const autoDecision = this.checkAutoRules(request);
      if (autoDecision === "deny") {
        this.audit({ event: "auto-denied", request });
        const injection = injectDenial(this.interceptor, request, "blocked by auto-deny rule");
        this.recordHistory(
          request,
          {
            requestId: request.id,
            decision: "deny",
            resolvedAtMs: Date.now(),
            resolvedBy: "auto-deny",
          },
          injection,
        );
        return;
      }
      if (autoDecision === "approve") {
        this.audit({ event: "auto-approved", request });
        this.emit({ type: "request-detected", request });
        await this.executeAndInject(request, {
          requestId: request.id,
          decision: "approve",
          resolvedAtMs: Date.now(),
          resolvedBy: "auto-approve",
        });
        return;
      }

      // Track as pending
      this.state.pending.set(request.id, request);
      this.emit({ type: "request-detected", request });
      this.audit({ event: "request-detected", request });

      // Forward to operator for authorization
      this.emit({ type: "authorization-requested", requestId: request.id });
      await this.forwarder.requestAuthorization(request);
    } catch (err) {
      this.emit({ type: "error", message: `Analyzer failed: ${err}`, ts: Date.now() });
    }
  }

  private async handleAuthorization(auth: ConductorAuthorization): Promise<void> {
    const request = this.state.pending.get(auth.requestId);
    if (!request) {
      return; // Already handled or expired
    }

    this.state.pending.delete(auth.requestId);
    this.emit({ type: "authorization-received", auth });
    this.audit({ event: "authorization-received", auth });

    if (auth.decision === "deny") {
      const injection = injectDenial(this.interceptor, request, "operator denied");
      this.recordHistory(request, auth, injection);
      return;
    }

    // Approved — execute browser actions and inject result
    await this.executeAndInject(request, auth);
  }

  private async executeAndInject(
    request: ExternalAccessRequest,
    auth: ConductorAuthorization,
  ): Promise<void> {
    this.emit({ type: "executing", requestId: request.id });

    try {
      const results = await this.executor.execute(request, auth);
      const injection = injectResults(this.interceptor, request, results);

      this.emit({ type: "injection", injection });
      this.audit({ event: "injection", injection });
      this.recordHistory(request, auth, injection);

      // Notify operator of result
      await this.forwarder.notifyResult(request, injection);
    } catch (err) {
      const errMsg = String(err);
      this.emit({ type: "error", message: errMsg, requestId: request.id, ts: Date.now() });
      const injection = injectDenial(this.interceptor, request, `execution failed: ${errMsg}`);
      this.recordHistory(request, auth, injection);
    }
  }

  // -------------------------------------------------------------------------
  // Auto-approve/deny rules
  // -------------------------------------------------------------------------

  private checkAutoRules(request: ExternalAccessRequest): "approve" | "deny" | null {
    const url = request.url;
    if (!url) {
      return null;
    }

    const denyPatterns = this.config.auth?.autoDenyPatterns ?? [];
    for (const pattern of denyPatterns) {
      if (matchGlob(pattern, url)) {
        return "deny";
      }
    }

    const approvePatterns = this.config.auth?.autoApprovePatterns ?? [];
    for (const pattern of approvePatterns) {
      if (matchGlob(pattern, url)) {
        return "approve";
      }
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // History & audit
  // -------------------------------------------------------------------------

  private recordHistory(
    request: ExternalAccessRequest,
    auth: ConductorAuthorization,
    injection?: ReturnType<typeof injectResults>,
  ): void {
    const entry: ConductorHistoryEntry = {
      request,
      authorization: auth,
      injection,
      completedAtMs: Date.now(),
    };
    this.state.history.push(entry);
  }

  private emit(event: ConductorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the conductor
      }
    }
  }

  private audit(data: Record<string, unknown>): void {
    if (!this.auditStream) {
      return;
    }
    const line = JSON.stringify({ ...data, ts: Date.now() });
    this.auditStream.write(`${line}\n`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function matchGlob(pattern: string, value: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`, "i").test(value);
}
