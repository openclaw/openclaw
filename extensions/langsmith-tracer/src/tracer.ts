/**
 * LangSmithTracer — RunTree state machine for the OpenClaw agent loop.
 *
 * ## Trace hierarchy
 *
 * Each agent turn (one user message → one reply) produces this structure:
 *
 *   openclaw-agent  [chain]          ← before_agent_start … agent_end
 *     anthropic/claude-…  [llm]      ← llm_input … llm_output (turn 1)
 *       bash  [tool]                 ← before_tool_call … after_tool_call
 *       read_file  [tool]
 *     anthropic/claude-…  [llm]      ← llm_input … llm_output (turn 2)
 *
 * ## State machine (per sessionId)
 *
 *   ┌─ before_agent_start ─┐  creates rootRun
 *   │   llm_input           │  creates currentLlmRun as child of rootRun
 *   │     before_tool_call  │  pushes tool run onto pendingToolStack
 *   │     after_tool_call   │  pops + closes tool run
 *   │   llm_output          │  closes currentLlmRun
 *   │   (repeat for N turns)│
 *   └─ agent_end ──────────┘  closes rootRun, removes session from map
 *
 * ## Error safety
 *
 * Every public method catches all errors internally — a LangSmith failure must
 * never break the agent loop. Errors are logged to the provided logger.
 */

import { RunTree } from "langsmith";
import type { Client } from "langsmith";

// Hook event types (mirrors src/plugins/types.ts, inlined to avoid core imports)
export type LlmInputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};

export type LlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type AgentStartEvent = {
  prompt: string;
  messages?: unknown[];
};

export type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

export type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
};

export type AfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

type SessionTrace = {
  rootRun: RunNode;
  /** The LLM call currently in progress; null between turns. */
  currentLlmRun: RunNode | null;
  /**
   * Stack of tool RunNodes. Pushed on before_tool_call, popped on
   * after_tool_call. Depth is almost always ≤ 1; a stack handles edge cases
   * where two tools could theoretically overlap.
   */
  pendingToolStack: RunNode[];
};

export type TracerLogger = {
  warn: (msg: string) => void;
  info?: (msg: string) => void;
};

/** Minimal interface for a run node — matches RunTree's used methods. */
export interface RunNode {
  postRun(): Promise<void>;
  createChild(cfg: Record<string, unknown>): RunNode;
  end(outputs?: Record<string, unknown>, error?: string): Promise<void>;
  patchRun(): Promise<void>;
}

/** Factory that creates root RunNodes. Injected so tests can supply fakes. */
export type RunNodeFactory = (cfg: Record<string, unknown>) => RunNode;

export class LangSmithTracer {
  private readonly projectName: string;
  private readonly logger: TracerLogger;
  private readonly createRootRun: RunNodeFactory;
  /** Active traces indexed by sessionId. */
  private readonly sessions = new Map<string, SessionTrace>();

  constructor(opts: {
    client: Client;
    projectName: string;
    logger: TracerLogger;
    /** Override for testing — defaults to `new RunTree(cfg)`. */
    _runNodeFactory?: RunNodeFactory;
  }) {
    this.projectName = opts.projectName;
    this.logger = opts.logger;
    this.createRootRun =
      opts._runNodeFactory ??
      ((cfg) =>
        new RunTree({
          ...(cfg as Parameters<typeof RunTree>[0]),
          client: opts.client,
        }));
  }

  // ── before_agent_start ────────────────────────────────────────────────────

  async onAgentStart(sessionId: string, event: AgentStartEvent): Promise<void> {
    try {
      // Close any leaked session from a previous run on the same session slot.
      if (this.sessions.has(sessionId)) {
        this.logger.warn(
          `langsmith-tracer: session ${sessionId} already active — closing stale trace`,
        );
        await this._closeSession(sessionId, false, "replaced by new agent start");
      }

      const rootRun = this.createRootRun({
        name: "openclaw-agent",
        run_type: "chain",
        project_name: this.projectName,
        inputs: { prompt: event.prompt },
      });
      await rootRun.postRun();

      this.sessions.set(sessionId, {
        rootRun,
        currentLlmRun: null,
        pendingToolStack: [],
      });
    } catch (err) {
      this.logger.warn(`langsmith-tracer: onAgentStart failed: ${String(err)}`);
    }
  }

  // ── llm_input ─────────────────────────────────────────────────────────────

  async onLlmInput(sessionId: string, event: LlmInputEvent): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return; // tracing not started for this session

      const parent = session.currentLlmRun ?? session.rootRun;
      const llmRun = parent.createChild({
        name: `${event.provider}/${event.model}`,
        run_type: "llm",
        inputs: {
          system: event.systemPrompt ?? "",
          messages: event.historyMessages,
          images_count: event.imagesCount,
        },
      });
      await llmRun.postRun();

      session.currentLlmRun = llmRun;
    } catch (err) {
      this.logger.warn(`langsmith-tracer: onLlmInput failed: ${String(err)}`);
    }
  }

  // ── before_tool_call ──────────────────────────────────────────────────────

  async onBeforeToolCall(sessionId: string, event: BeforeToolCallEvent): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return;

      // Tools are children of the LLM run that requested them; fall back to
      // root if there is no active LLM run (shouldn't happen in normal flow).
      const parent = session.currentLlmRun ?? session.rootRun;
      const toolRun = parent.createChild({
        name: event.toolName,
        run_type: "tool",
        inputs: event.params,
      });
      await toolRun.postRun();

      session.pendingToolStack.push(toolRun);
    } catch (err) {
      this.logger.warn(`langsmith-tracer: onBeforeToolCall failed: ${String(err)}`);
    }
  }

  // ── after_tool_call ───────────────────────────────────────────────────────

  async onAfterToolCall(sessionId: string, event: AfterToolCallEvent): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return;

      const toolRun = session.pendingToolStack.pop();
      if (!toolRun) return; // no matching start (shouldn't happen)

      await toolRun.end(event.error ? undefined : { output: event.result }, event.error);
      await toolRun.patchRun();
    } catch (err) {
      this.logger.warn(`langsmith-tracer: onAfterToolCall failed: ${String(err)}`);
    }
  }

  // ── llm_output ────────────────────────────────────────────────────────────

  async onLlmOutput(sessionId: string, event: LlmOutputEvent): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session?.currentLlmRun) return;

      const llmRun = session.currentLlmRun;
      session.currentLlmRun = null;

      await llmRun.end({
        generations: event.assistantTexts,
        usage: event.usage ?? {},
      });
      await llmRun.patchRun();
    } catch (err) {
      this.logger.warn(`langsmith-tracer: onLlmOutput failed: ${String(err)}`);
    }
  }

  // ── agent_end ─────────────────────────────────────────────────────────────

  async onAgentEnd(sessionId: string, event: AgentEndEvent): Promise<void> {
    await this._closeSession(sessionId, event.success, event.error);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async _closeSession(sessionId: string, success: boolean, error?: string): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      this.sessions.delete(sessionId);

      // Close any dangling tool runs.
      for (const toolRun of session.pendingToolStack.reverse()) {
        try {
          await toolRun.end(undefined, "agent ended with tool still pending");
          await toolRun.patchRun();
        } catch {
          // best-effort
        }
      }

      // Close dangling LLM run.
      if (session.currentLlmRun) {
        try {
          await session.currentLlmRun.end(undefined, "agent ended with LLM call still pending");
          await session.currentLlmRun.patchRun();
        } catch {
          // best-effort
        }
      }

      await session.rootRun.end(
        success ? { success: true } : undefined,
        success ? undefined : (error ?? "agent run failed"),
      );
      await session.rootRun.patchRun();
    } catch (err) {
      this.logger.warn(`langsmith-tracer: _closeSession failed: ${String(err)}`);
    }
  }

  /** Returns the number of active sessions (for testing). */
  get activeSessionCount(): number {
    return this.sessions.size;
  }
}
