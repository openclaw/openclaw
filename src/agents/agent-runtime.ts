import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { EmbeddedPiSubscribeEvent } from "./pi-embedded-subscribe.handlers.types.js";

export interface AgentRuntimeSession {
  subscribe(handler: (evt: EmbeddedPiSubscribeEvent) => void): () => void;
  prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>;

  /**
   * Steer the agent with a new instruction mid-session.
   * Pi injects steer text mid-loop. Claude SDK does best-effort mid-loop injection by
   * interrupting/resuming between yielded messages, and falls back to next-turn delivery
   * if no safe interruption point is reached.
   */
  steer(text: string): Promise<void>;

  /** Cancel the current in-flight operation. Callers use `void runtime.abort()` — the returned Promise is intentionally fire-and-forget. */
  abort(): Promise<void>;
  abortCompaction(): void;
  dispose(): void;
  replaceMessages(messages: AgentMessage[]): void;
  setSystemPrompt?(text: string): void;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly messages: AgentMessage[];
  readonly sessionId: string;
  readonly runtimeHints: AgentRuntimeHints;
}

export interface AgentRuntimeHints {
  /** Whether to allow synthetic tool result repair in SessionManager. */
  allowSyntheticToolResults: boolean;
  /** Whether to enforce <final> tag extraction. */
  enforceFinalTag: boolean;
  /** Whether this runtime manages its own message history (skip local sanitization/repair). */
  managesOwnHistory: boolean;
  /** Whether the runtime supports local streamFn wrapping (Pi-specific). */
  supportsStreamFnWrapping: boolean;
  /** Session file path for hook context (undefined for runtimes without local session files). */
  sessionFile?: string;
}
