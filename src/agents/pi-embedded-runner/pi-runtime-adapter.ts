import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { AgentRuntimeSession, AgentRuntimeHints } from "../agent-runtime.js";
import type { EmbeddedPiSubscribeEvent } from "../pi-embedded-subscribe.handlers.types.js";

type PiAgentSession = {
  subscribe(handler: (evt: EmbeddedPiSubscribeEvent) => void): () => void;
  prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  abortCompaction(): void;
  dispose(): void;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly messages: AgentMessage[];
  readonly sessionId: string;
  readonly agent: {
    streamFn: unknown;
    replaceMessages(messages: AgentMessage[]): void;
    setSystemPrompt(prompt: string): void;
  };
};

export type PiRuntimeAdapterParams = {
  session: PiAgentSession;
  runtimeHints: AgentRuntimeHints;
};

export function createPiRuntimeAdapter(params: PiRuntimeAdapterParams): AgentRuntimeSession {
  const { session, runtimeHints } = params;
  return {
    subscribe: (handler) => session.subscribe(handler),
    prompt: (text, options) => session.prompt(text, options),
    steer: (text) => session.steer(text),
    abort: () => session.abort(),
    abortCompaction: () => session.abortCompaction(),
    dispose: () => session.dispose(),
    replaceMessages: (messages) => session.agent.replaceMessages(messages),
    setSystemPrompt: (text) => {
      session.agent.setSystemPrompt(text);
    },
    get isStreaming() {
      return session.isStreaming;
    },
    get isCompacting() {
      return session.isCompacting;
    },
    get messages() {
      return session.messages;
    },
    get sessionId() {
      return session.sessionId;
    },
    runtimeHints,
  };
}
