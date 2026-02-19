/**
 * Pi-Agent Runtime — Wraps the existing @mariozechner/pi-* packages
 * behind the AgentRuntime interface.
 *
 * This is a thin adapter that delegates to the existing code.
 * No behavior changes — the existing pi-agent path continues to work exactly as before.
 *
 * During the transition period, callers like `attempt.ts` continue to use the
 * pi-agent API directly. This module provides:
 * 1. `wrapPiAgentSession()` — wraps an already-created pi-agent session
 * 2. `createPiAgentRuntime()` — full AgentRuntime (for new code)
 */

import { fromPiAgentEvent } from "./event-bridge.js";
import type {
  AgentRuntime,
  CreateSessionOptions,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeSession,
  ThinkLevel,
} from "./types.js";

/**
 * Wrap an existing pi-agent session (from createAgentSession) in a RuntimeSession.
 *
 * This is the primary migration path: existing code creates the session as before,
 * then wraps it so downstream consumers can use the abstract interface.
 */
export function wrapPiAgentSession(piSession: unknown): RuntimeSession {
  return new PiAgentSessionAdapter(piSession);
}

/**
 * Create the pi-agent runtime.
 *
 * Note: `createSession` is a simplified path. The real pi-agent session creation
 * in `attempt.ts` is much more involved. This exists as a reference implementation
 * and for simpler use cases.
 */
export function createPiAgentRuntime(): AgentRuntime {
  return {
    type: "pi-agent",

    async createSession(_options: CreateSessionOptions): Promise<RuntimeSession> {
      // The full session creation logic lives in attempt.ts.
      // For the adapter pattern, callers should create the pi-agent session
      // themselves and use wrapPiAgentSession() instead.
      throw new Error(
        "createPiAgentRuntime().createSession() is not supported. " +
          "Use wrapPiAgentSession() with an existing pi-agent session instead.",
      );
    },

    dispose() {
      // No global cleanup needed for pi-agent
    },
  };
}

/**
 * Wraps a pi-agent AgentSession in the RuntimeSession interface.
 */
class PiAgentSessionAdapter implements RuntimeSession {
  private piSession: Record<string, unknown>;
  private listeners: Array<(event: RuntimeEvent) => void> = [];
  private unsubPi: (() => void) | null = null;

  constructor(piSession: unknown) {
    this.piSession = piSession as Record<string, unknown>;

    // Subscribe to pi-agent events and forward as RuntimeEvents
    const session = this.piSession;
    if (typeof session.subscribe === "function") {
      this.unsubPi = (session.subscribe as (fn: (e: unknown) => void) => () => void)(
        (event: unknown) => {
          const runtimeEvents = fromPiAgentEvent(event);
          for (const re of runtimeEvents) {
            for (const listener of this.listeners) {
              listener(re);
            }
          }
        },
      );
    }
  }

  get sessionId(): string {
    return (this.piSession.sessionId as string) ?? "";
  }

  get messages(): RuntimeMessage[] {
    const agent = this.piSession.agent as { state?: { messages?: unknown[] } } | undefined;
    const raw = (agent?.state?.messages ?? []) as Array<{ role?: string; content?: unknown }>;
    return raw.map((m) => ({
      role:
        m.role === "assistant"
          ? ("assistant" as const)
          : m.role === "system"
            ? ("system" as const)
            : ("user" as const),
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      raw: m,
    }));
  }

  get isStreaming(): boolean {
    const agent = this.piSession.agent as { state?: { isStreaming?: boolean } } | undefined;
    return agent?.state?.isStreaming ?? false;
  }

  async prompt(text: string, images?: Array<{ mediaType: string; data: string }>): Promise<void> {
    const agent = this.piSession.agent as
      | { prompt?: (...args: unknown[]) => Promise<void> }
      | undefined;
    if (!agent?.prompt) {
      return;
    }

    if (images && images.length > 0) {
      const imageContents = images.map((img) => ({
        type: "image" as const,
        mediaType: img.mediaType,
        data: img.data,
      }));
      await agent.prompt(text, imageContents);
    } else {
      await agent.prompt(text);
    }
  }

  steer(text: string): void {
    const agent = this.piSession.agent as { steer?: (m: unknown) => void } | undefined;
    agent?.steer?.({
      role: "user",
      content: text,
      timestamp: Date.now(),
    });
  }

  abort(): void {
    const agent = this.piSession.agent as { abort?: () => void } | undefined;
    agent?.abort?.();
  }

  async waitForIdle(): Promise<void> {
    const agent = this.piSession.agent as { waitForIdle?: () => Promise<void> } | undefined;
    await agent?.waitForIdle?.();
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) {
        this.listeners.splice(idx, 1);
      }
    };
  }

  setSystemPrompt(prompt: string): void {
    const agent = this.piSession.agent as { setSystemPrompt?: (p: string) => void } | undefined;
    agent?.setSystemPrompt?.(prompt);
  }

  setModel(_model: string): void {
    // pi-agent requires a Model object, not a string.
    // Callers needing full control should use getRawSession().
  }

  setThinkLevel(level: ThinkLevel): void {
    const agent = this.piSession.agent as { setThinkingLevel?: (l: string) => void } | undefined;
    agent?.setThinkingLevel?.(level);
  }

  getRawSession(): unknown {
    return this.piSession;
  }

  dispose(): void {
    this.unsubPi?.();
    this.listeners.length = 0;
  }
}
