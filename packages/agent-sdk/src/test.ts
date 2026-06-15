// @openclaw/agent-sdk/test — Test harness for agent package behavior proofs.

export interface MockResponse {
  role: "assistant";
  content: MockContent[];
}

export type MockContent =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; input: Record<string, unknown> };

export interface MockModelConfig {
  responses: MockResponse[];
}

/** Mock model: returns canned responses. No network. No real LLM. */
export class MockModel {
  private responses: MockResponse[];
  private index: number = 0;

  constructor(config: MockModelConfig) {
    this.responses = [...config.responses];
  }

  nextResponse(): MockResponse | null {
    if (this.index >= this.responses.length) return null;
    return this.responses[this.index++];
  }

  hasMore(): boolean {
    return this.index < this.responses.length;
  }

  reset(): void {
    this.index = 0;
  }
}

export interface MockToolConfig {
  allow?: boolean;
  result?: unknown;
  error?: string;
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  blocked: boolean;
  result?: unknown;
  error?: string;
}

/** Mock tool dispatcher: records invocations, returns configured results. */
export class MockTools {
  private config: Record<string, MockToolConfig>;
  private calls: ToolCallRecord[] = [];

  constructor(config: Record<string, MockToolConfig>) {
    this.config = config;
  }

  dispatch(name: string, input: Record<string, unknown>): unknown {
    const toolConfig = this.config[name];
    const allowed = toolConfig?.allow !== false;

    if (!allowed) {
      const record: ToolCallRecord = { name, input, blocked: true, error: "tool denied: " + name };
      this.calls.push(record);
      throw new Error("tool denied: " + name);
    }

    const record: ToolCallRecord = { name, input, blocked: false, result: toolConfig?.result };
    this.calls.push(record);

    if (toolConfig?.error) throw new Error(toolConfig.error);
    return toolConfig?.result;
  }

  getCalls(): ToolCallRecord[] {
    return [...this.calls];
  }
  getCallsFor(name: string): ToolCallRecord[] {
    return this.calls.filter((c) => c.name === name);
  }
  wasCalled(name: string): boolean {
    return this.calls.some((c) => c.name === name);
  }
  hadBlockedCall(): boolean {
    return this.calls.some((c) => c.blocked);
  }
  reset(): void {
    this.calls = [];
  }
}

export interface HarnessConfig {
  manifestPath: string;
  mockModel: MockModelConfig;
  mockTools: Record<string, MockToolConfig>;
}

export interface HarnessResult {
  toolCalls: ToolCallRecord[];
  blocked: boolean;
  transcript: MockResponse[];
}

/** Test harness: mock model + mock tools. Deterministic behavior proofs. */
export class AgentTestHarness {
  private model: MockModel;
  private tools: MockTools;
  private transcript: MockResponse[] = [];

  constructor(config: HarnessConfig) {
    this.model = new MockModel(config.mockModel);
    this.tools = new MockTools(config.mockTools);
  }

  async run(): Promise<HarnessResult> {
    this.transcript = [];

    while (this.model.hasMore()) {
      const response = this.model.nextResponse();
      if (!response) break;
      this.transcript.push(response);

      for (const content of response.content) {
        if (content.type === "toolCall") {
          try {
            this.tools.dispatch(content.name, content.input);
          } catch {
            // Tool denied — recorded in mock tools
          }
        }
      }
    }

    return {
      toolCalls: this.tools.getCalls(),
      blocked: this.tools.hadBlockedCall(),
      transcript: [...this.transcript],
    };
  }

  getModel(): MockModel {
    return this.model;
  }
  getTools(): MockTools {
    return this.tools;
  }
  reset(): void {
    this.model.reset();
    this.tools.reset();
    this.transcript = [];
  }
}
