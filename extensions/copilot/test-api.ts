/** Test-only Copilot boundary for host/plugin integration suites. */
import {
  CopilotClient,
  CopilotSession,
  type AssistantMessageEvent,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionEvent,
  type Tool,
} from "@github/copilot-sdk";
import { createCopilotAgentHarness } from "./harness.js";
import { createCopilotClientPool } from "./src/runtime.js";

type CopilotSessionConfigProbe = {
  availableTools: readonly string[] | undefined;
  toolNames: readonly string[];
  writeHandler: boolean;
};

function projectSessionConfig(
  config: SessionConfig | ResumeSessionConfig,
): CopilotSessionConfigProbe {
  const tools = config.tools ?? [];
  return {
    availableTools: Array.isArray(config.availableTools) ? [...config.availableTools] : undefined,
    toolNames: tools.map((tool) => tool.name),
    writeHandler: typeof tools.find((tool) => tool.name === "write")?.handler === "function",
  };
}

function createAssistantMessageEvent(id: string): AssistantMessageEvent {
  return {
    data: { content: "done", messageId: id },
    id,
    parentId: null,
    timestamp: "2026-09-09T00:00:00.000Z",
    type: "assistant.message",
  };
}

function createProbeSession(params: {
  onSend: () => Promise<void>;
  sessionId: string;
}): CopilotSession {
  const listeners = new Map<string, Array<(event: SessionEvent) => void>>();
  const session: CopilotSession = Object.assign(Object.create(CopilotSession.prototype), {
    abort: async () => undefined,
    disconnect: async () => undefined,
    on(eventType: string, handler: (event: SessionEvent) => void) {
      listeners.set(eventType, [...(listeners.get(eventType) ?? []), handler]);
    },
    send: async () => "sdk-user",
    async sendAndWait() {
      await params.onSend();
      const event = createAssistantMessageEvent(`assistant-${params.sessionId}`);
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event);
      }
      return event;
    },
    sessionId: params.sessionId,
  });
  return session;
}

/**
 * Creates the real Copilot harness and tool bridge around an in-memory SDK transport probe.
 * The probe executes an exposed `write` handler so host integration tests can observe the
 * final filesystem boundary without requiring a provider account.
 */
export function createCopilotToolPolicyHarnessFixtureForTest(outputPath: string) {
  const createConfigs: CopilotSessionConfigProbe[] = [];
  const resumeConfigs: CopilotSessionConfigProbe[] = [];
  const writeResults: unknown[] = [];
  let sessionCount = 0;

  const runWriteIfExposed = async (config: SessionConfig | ResumeSessionConfig) => {
    const write = config.tools?.find((tool): tool is Tool => tool.name === "write");
    if (
      !write?.handler ||
      !Array.isArray(config.availableTools) ||
      !config.availableTools.includes("write")
    ) {
      return;
    }
    writeResults.push(
      await write.handler(
        { path: outputPath, content: `write-${createConfigs.length}-${resumeConfigs.length}` },
        {
          arguments: { path: outputPath },
          sessionId: "copilot-policy-proof",
          toolCallId: `write-${createConfigs.length}-${resumeConfigs.length}`,
          toolName: "write",
        },
      ),
    );
  };
  const createSession = async (config: SessionConfig) => {
    createConfigs.push(projectSessionConfig(config));
    const sessionId = `sdk-session-${++sessionCount}`;
    return createProbeSession({
      sessionId,
      onSend: async () => {
        await runWriteIfExposed(config);
      },
    });
  };
  const resumeSession = async (sessionId: string, config: ResumeSessionConfig) => {
    resumeConfigs.push(projectSessionConfig(config));
    return createProbeSession({
      sessionId,
      onSend: async () => {
        await runWriteIfExposed(config);
      },
    });
  };
  const client: CopilotClient = Object.assign(Object.create(CopilotClient.prototype), {
    createSession,
    deleteSession: async () => undefined,
    resumeSession,
    stop: async () => [],
  });
  const pool = createCopilotClientPool({ sdkFactory: async () => client });
  const harness = createCopilotAgentHarness({ pool });
  return {
    createConfigs,
    harness,
    resumeConfigs,
    writeResults,
    async dispose() {
      await harness.dispose?.();
      await pool.dispose();
    },
  };
}
