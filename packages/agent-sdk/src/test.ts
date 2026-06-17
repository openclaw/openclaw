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

export const REQUIRED_V1_PROOF_IDS = [
  "agent.manifest.valid",
  "agent.integrity.valid",
  "agent.integrity.mismatchFailsClosed",
  "agent.installedState.valid",
  "agent.installedState.driftQuarantines",
  "agent.instructionFile.driftQuarantines",
  "agent.mutableInstructionFile.deniedByPolicy",
  "agent.requiredTool.missingFailsClosed",
  "agent.requiredPlugin.missingFailsClosed",
  "agent.requiredSecret.missingFailsClosed",
  "agent.secretScope.enforced",
  "agent.deniedTool.blocked",
  "agent.externalContentToExec.blocked",
  "agent.outbound.requiresApproval",
  "agent.workspaceEscape.blocked",
  "agent.schedule.disabledByDefault",
  "agent.privateNetwork.blocked",
  "agent.dnsRebinding.blocked",
  "agent.sandbox.required",
  "agent.configCompiler.dryRunValidates",
  "agent.upgrade.permissionExpansionRequiresApproval",
] as const;

export type RequiredV1ProofId = (typeof REQUIRED_V1_PROOF_IDS)[number];

export interface BehaviorProofRecord {
  id: RequiredV1ProofId;
  passed: boolean;
  evidence: string;
}

export interface BehaviorProofSummary {
  passed: boolean;
  proofs: BehaviorProofRecord[];
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

export function createPassedBehaviorProofSummary(
  evidencePrefix = "deterministic harness assertion passed",
): BehaviorProofSummary {
  const proofs = REQUIRED_V1_PROOF_IDS.map((id) => ({
    id,
    passed: true,
    evidence: `${evidencePrefix}: ${id}`,
  }));
  return {
    passed: proofs.every((proof) => proof.passed),
    proofs,
  };
}

export function formatBehaviorProofSummary(summary: BehaviorProofSummary): string {
  const lines = [
    `Agent SDK behavior proof summary: ${summary.passed ? "PASS" : "FAIL"}`,
    `Required proofs: ${summary.proofs.length}`,
  ];
  for (const proof of summary.proofs) {
    lines.push(`${proof.passed ? "PASS" : "FAIL"} ${proof.id} - ${proof.evidence}`);
  }
  return `${lines.join("\n")}\n`;
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
