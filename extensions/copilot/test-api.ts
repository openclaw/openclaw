/** Test-only Copilot boundary for host/plugin integration suites. */
import {
  CopilotClient,
  CopilotRequestHandler,
  CopilotSession,
  type AssistantMessageEvent,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionEvent,
  type Tool,
} from "@github/copilot-sdk";
import { createCopilotAgentHarness, type CopilotSessionBinding } from "./harness.js";
import { createCopilotClientPool, type CopilotClientPool } from "./src/runtime.js";

export type CopilotSessionBindingForTest = CopilotSessionBinding;

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

type NativeModelRequestBody = {
  messages?: Array<{ content?: unknown; role?: unknown; tool_call_id?: unknown }>;
  stream?: unknown;
  tools?: Array<{ function?: { name?: unknown } }>;
};

type NativeModelRequestProbe = { restricted: boolean; streaming: boolean; toolNames: string[] };

class NativePolicyRequestHandler extends CopilotRequestHandler {
  constructor(private readonly requests: NativeModelRequestProbe[]) {
    super();
  }

  protected override async sendRequest(request: Request): Promise<Response> {
    // SAFETY: this handler is installed only on the fixture's OpenAI chat-completions provider.
    const body = (await request.json()) as NativeModelRequestBody;
    const messages = body.messages ?? [];
    const toolNames = (body.tools ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => typeof name === "string");
    const restricted = messages.some(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("This question must be blocked"),
    );
    const answeredAllowedQuestion = messages.some(
      (message) => message.role === "tool" && message.tool_call_id === "call_ask_user_allowed",
    );
    const answeredRestrictedQuestion = messages.some(
      (message) => message.role === "tool" && message.tool_call_id === "call_ask_user_restricted",
    );
    this.requests.push({ restricted, streaming: body.stream === true, toolNames });

    const callAskUser =
      toolNames.includes("ask_user") &&
      (restricted ? !answeredRestrictedQuestion : !answeredAllowedQuestion);
    const message = callAskUser
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: restricted ? "call_ask_user_restricted" : "call_ask_user_allowed",
              type: "function",
              function: {
                name: "ask_user",
                arguments: JSON.stringify({
                  questions: [
                    {
                      id: "live_proof_mode",
                      header: "Proof mode",
                      question: restricted
                        ? "This question must be blocked"
                        : "Select the live proof mode",
                      options: [
                        { label: "Alpha (Recommended)", description: "Use alpha mode." },
                        { label: "Beta", description: "Use beta mode." },
                      ],
                    },
                  ],
                }),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: restricted ? "RESTRICTED-NO-ASK-USER" : "ALLOWED-AFTER-ANSWER",
        };
    return Response.json({
      id: `chatcmpl-copilot-policy-${this.requests.length}`,
      object: "chat.completion",
      created: 0,
      model: "gpt-5.4-mini",
      choices: [{ index: 0, message, finish_reason: callAskUser ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }
}

function withNativeFixtureProvider(config: SessionConfig): SessionConfig;
function withNativeFixtureProvider(config: ResumeSessionConfig): ResumeSessionConfig;
function withNativeFixtureProvider(
  config: SessionConfig | ResumeSessionConfig,
): SessionConfig | ResumeSessionConfig {
  const { gitHubToken: _gitHubToken, ...configWithoutGitHubToken } = config;
  return {
    ...configWithoutGitHubToken,
    provider: {
      type: "openai",
      wireApi: "completions",
      baseUrl: "https://copilot-policy-fixture.invalid/v1",
      apiKey: "copilot-policy-fixture-key",
      modelId: "gpt-5.4-mini",
      wireModel: "gpt-5.4-mini",
    },
  };
}

function createNativePolicyPool(requests: NativeModelRequestProbe[]): CopilotClientPool {
  const activeClients = new Set<CopilotClient>();
  return {
    async acquire(key, options) {
      const { copilotHome, gitHubToken: _gitHubToken, ...clientOptions } = options;
      const client = new CopilotClient({
        ...clientOptions,
        baseDirectory: copilotHome,
        requestHandler: new NativePolicyRequestHandler(requests),
        useLoggedInUser: false,
      });
      activeClients.add(client);
      const pooledClient: CopilotClient = Object.assign(Object.create(CopilotClient.prototype), {
        createSession: (config: SessionConfig) =>
          client.createSession(withNativeFixtureProvider(config)),
        deleteSession: (sessionId: string) => client.deleteSession(sessionId),
        resumeSession: (sessionId: string, config: ResumeSessionConfig) =>
          client.resumeSession(sessionId, withNativeFixtureProvider(config)),
        stop: () => client.stop(),
      });
      return {
        key,
        client: pooledClient,
      };
    },
    async dispose() {
      const results = await Promise.all([...activeClients].map((client) => client.stop()));
      activeClients.clear();
      return results.flat();
    },
    async release() {},
    size() {
      return activeClients.size;
    },
  };
}

/** Runs the real Copilot CLI and SDK against a deterministic model-layer request handler. */
export function createNativeCopilotPolicyHarnessFixtureForTest(sessionStore: {
  delete(key: string): boolean;
  lookup(key: string): CopilotSessionBinding | undefined;
  register(key: string, value: CopilotSessionBinding): void;
}) {
  const requests: NativeModelRequestProbe[] = [];
  const pool = createNativePolicyPool(requests);
  const harness = createCopilotAgentHarness({ pool, sessionStore });
  return {
    harness,
    requests,
    async dispose() {
      await harness.dispose?.();
      await pool.dispose();
    },
  };
}
