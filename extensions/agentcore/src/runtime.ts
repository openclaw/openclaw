import crypto from "node:crypto";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
  RetrieveMemoryRecordsCommand,
  StartMemoryExtractionJobCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
} from "openclaw/plugin-sdk/acpx";
import { AcpRuntimeError } from "openclaw/plugin-sdk/acpx";
import { hasHyperionRuntime, getHyperionRuntime } from "../../hyperion/src/globals.js";
import { extractTenantId, extractAgentId, DEFAULT_AGENT_ID } from "../../hyperion/src/lib/index.js";
import type { AgentCoreHandleState, AgentCoreRuntimeConfig } from "./types.js";

export const AGENTCORE_BACKEND_ID = "agentcore";

const HANDLE_PREFIX = "agentcore:v1:";
const DEFAULT_INVOKE_TIMEOUT_MS = 300_000; // 5 minutes

const AGENTCORE_CAPABILITIES: AcpRuntimeCapabilities = {
  // AgentCore doesn't expose OC-style session controls
  controls: [],
};

// ---------------------------------------------------------------------------
// Handle state encoding (persisted in AcpRuntimeHandle.runtimeSessionName)
// ---------------------------------------------------------------------------

function encodeHandleState(state: AgentCoreHandleState): string {
  return `${HANDLE_PREFIX}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
}

function decodeHandleState(runtimeSessionName: string): AgentCoreHandleState | null {
  if (!runtimeSessionName.startsWith(HANDLE_PREFIX)) {
    return null;
  }
  try {
    const encoded = runtimeSessionName.slice(HANDLE_PREFIX.length);
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AgentCoreHandleState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runtime ARN selection
// ---------------------------------------------------------------------------

/**
 * Pick a runtime ARN from the configured pool.
 * Simple random selection; can be replaced with health-aware routing.
 */
function pickRuntimeArn(arns: string[]): string {
  if (arns.length === 0) {
    throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "No AgentCore Runtime ARNs configured.");
  }
  if (arns.length === 1) {
    return arns[0]!;
  }
  return arns[Math.floor(Math.random() * arns.length)]!;
}

// ---------------------------------------------------------------------------
// AgentCore AcpRuntime implementation
// ---------------------------------------------------------------------------

export class AgentCoreRuntime implements AcpRuntime {
  private healthy = false;
  private readonly client: BedrockAgentCoreClient;
  private readonly config: AgentCoreRuntimeConfig;

  constructor(config: AgentCoreRuntimeConfig) {
    this.config = config;
    this.client = new BedrockAgentCoreClient({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    });
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  setHealthy(value: boolean): void {
    this.healthy = value;
  }

  // -------------------------------------------------------------------------
  // ensureSession — creates session state for subsequent runTurn calls
  // -------------------------------------------------------------------------

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const agent = input.agent?.trim();
    if (!agent) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Agent ID is required.");
    }
    const sessionKey = input.sessionKey?.trim();
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Session key is required.");
    }

    const runtimeArn = pickRuntimeArn(this.config.runtimeArns);

    // [claude-infra] Derive tenant user_id from the Hyperion session key
    // (format: "tenant_{userId}:{agentId}:{rest}"), not from `agent` which
    // may be a shared logical name like "main" across different tenants.
    const tenantId = extractTenantId(sessionKey) ?? agent;
    // [claude-infra] Multi-instance: extract agent instance ID from session key.
    const agentId = extractAgentId(sessionKey);

    // AgentCore sessions are created implicitly on first InvokeAgentRuntime.
    // We generate a stable session ID here. For resumed sessions, reuse the
    // provided ID so AgentCore picks up the existing conversation.
    const sessionId = input.resumeSessionId || crypto.randomUUID();

    const state: AgentCoreHandleState = {
      runtimeArn,
      sessionId,
      tenantId,
      agentId,
      agent,
      mode: input.mode,
    };

    return {
      sessionKey,
      backend: AGENTCORE_BACKEND_ID,
      runtimeSessionName: encodeHandleState(state),
      cwd: input.cwd,
      backendSessionId: sessionId,
    };
  }

  // -------------------------------------------------------------------------
  // runTurn — invokes AgentCore and streams AcpRuntimeEvents back
  // -------------------------------------------------------------------------

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    const state = this.resolveHandleState(input.handle);
    // [claude-infra] Multi-instance: memory namespace includes agentId for isolation.
    // Uses configurable prefix (memoryNamespacePrefix from SSM) rather than
    // buildTenantMemoryNamespace() which hardcodes "tenant_".
    const memoryNamespace = `${this.config.memoryNamespacePrefix}${state.tenantId}:${state.agentId}`;

    // Load tenant config and retrieve memory in parallel.
    // Tenant config provides model, tools, custom_instructions, profile.
    // Memory provides prior conversation context for the agent.
    const [tenantContext, memoryRecords] = await Promise.all([
      this.loadTenantContext(state.tenantId, state.agentId),
      this.retrieveMemory(memoryNamespace, input.text),
    ]);

    const payload: Record<string, unknown> = {
      sessionId: state.sessionId,
      tenant_id: state.tenantId,
      message: input.text,
      ...(tenantContext ? { tenant_config: tenantContext } : {}),
      ...(memoryRecords.length > 0 ? { memory_context: memoryRecords } : {}),
    };

    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));

    let response;
    try {
      response = await this.client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: state.runtimeArn,
          runtimeSessionId: state.sessionId,
          runtimeUserId: state.tenantId,
          contentType: "application/json",
          accept: "application/json",
          payload: payloadBytes,
        }),
        {
          abortSignal: input.signal,
          requestTimeout: this.config.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS,
        },
      );
    } catch (err) {
      if (input.signal?.aborted) {
        return;
      }
      yield* this.handleInvocationError(err);
      return;
    }

    // Process the response stream and collect the full text for memory extraction.
    let fullResponseText = "";
    for await (const event of this.processResponse(response, state)) {
      if (event.type === "text_delta" && event.text) {
        fullResponseText += event.text;
      }
      yield event;
    }

    // Fire-and-forget: extract memories from this turn for future context.
    if (fullResponseText) {
      void this.extractMemory(memoryNamespace, input.text, fullResponseText);
    }
  }

  // -------------------------------------------------------------------------
  // cancel / close — session lifecycle
  // -------------------------------------------------------------------------

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    // Best-effort: stop the runtime session so AgentCore tears down the microVM.
    const state = this.resolveHandleState(input.handle);
    try {
      await this.client.send(
        new StopRuntimeSessionCommand({
          agentRuntimeArn: state.runtimeArn,
          runtimeSessionId: state.sessionId,
        }),
      );
    } catch {
      // Swallow errors — cancel is best-effort
    }
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    // For oneshot sessions, stop the runtime session.
    // For persistent sessions, leave it alive for future turns.
    const state = this.resolveHandleState(input.handle);
    if (state.mode === "oneshot") {
      try {
        await this.client.send(
          new StopRuntimeSessionCommand({
            agentRuntimeArn: state.runtimeArn,
            runtimeSessionId: state.sessionId,
          }),
        );
      } catch {
        // Best-effort cleanup
      }
    }
  }

  // -------------------------------------------------------------------------
  // getCapabilities / getStatus / doctor
  // -------------------------------------------------------------------------

  getCapabilities(): AcpRuntimeCapabilities {
    return AGENTCORE_CAPABILITIES;
  }

  async getStatus(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus> {
    const state = this.resolveHandleState(input.handle);
    return {
      summary: `agentcore session=${state.sessionId} runtime=${state.runtimeArn} tenant=${state.tenantId}`,
      backendSessionId: state.sessionId,
    };
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    if (this.config.runtimeArns.length === 0) {
      return {
        ok: false,
        code: "ACP_BACKEND_UNAVAILABLE",
        message:
          "No AgentCore Runtime ARNs configured. " +
          "Populate SSM parameter /hyperion/{stage}/agentcore/runtime-arns.",
      };
    }

    // Lightweight check: try to describe the first runtime
    try {
      // TODO: replace with a proper health ping when AgentCore exposes one.
      // For now, we just validate config is present.
      return {
        ok: true,
        message:
          `AgentCore backend configured ` +
          `(region: ${this.config.region}, runtimes: ${this.config.runtimeArns.length})`,
      };
    } catch (err) {
      return {
        ok: false,
        code: "ACP_BACKEND_UNAVAILABLE",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Load tenant config from the Hyperion runtime (DynamoDB).
   * Returns a subset of the config relevant to the agent container:
   * model, custom_instructions, tools, profile, display_name.
   */
  // [claude-infra] Multi-instance: loads config for specific agent instance.
  private async loadTenantContext(
    tenantId: string,
    agentId: string = DEFAULT_AGENT_ID,
  ): Promise<Record<string, unknown> | null> {
    if (!hasHyperionRuntime()) return null;
    try {
      const runtime = getHyperionRuntime();
      const tenantConfig = await runtime.dbClient.getTenantConfig(tenantId, agentId);
      if (!tenantConfig) return null;
      return {
        user_id: tenantConfig.user_id,
        display_name: tenantConfig.display_name,
        model: tenantConfig.model ?? this.config.defaultModel,
        custom_instructions: tenantConfig.custom_instructions,
        tools: tenantConfig.tools,
        profile: tenantConfig.profile,
        plan: tenantConfig.plan,
      };
    } catch {
      // Non-fatal: agent can still run without tenant context
      return null;
    }
  }

  /**
   * Retrieve relevant memory records for this tenant before the turn.
   * Uses the user's message as a semantic query to find related memories.
   */
  private async retrieveMemory(
    namespace: string,
    query: string,
  ): Promise<Array<{ content: string; score?: number }>> {
    try {
      const resp = await this.client.send(
        new RetrieveMemoryRecordsCommand({
          namespace,
          query: { text: query },
          maxResults: 10,
        }),
      );
      if (!resp.records || resp.records.length === 0) return [];
      return resp.records.map((r) => ({
        content: r.content?.text ?? "",
        score: r.score,
      }));
    } catch {
      // Non-fatal: agent runs without memory context on failure
      return [];
    }
  }

  /**
   * Extract and persist memories from a completed turn (fire-and-forget).
   * AgentCore Memory will extract salient facts from the conversation.
   */
  private async extractMemory(
    namespace: string,
    userMessage: string,
    agentResponse: string,
  ): Promise<void> {
    try {
      await this.client.send(
        new StartMemoryExtractionJobCommand({
          namespace,
          content: {
            text: `User: ${userMessage}\nAssistant: ${agentResponse}`,
          },
        }),
      );
    } catch {
      // Best-effort: memory extraction failure is not user-facing
    }
  }

  private resolveHandleState(handle: AcpRuntimeHandle): AgentCoreHandleState {
    const state = decodeHandleState(handle.runtimeSessionName);
    if (!state) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "Invalid AgentCore runtime handle: could not decode state.",
      );
    }
    return state;
  }

  /**
   * Process the InvokeAgentRuntime response.
   *
   * The response.response is a StreamingBlob — we consume it as text and
   * parse the agent's output. The agent container returns JSON with a
   * "response" field containing the agent's reply text.
   *
   * For streaming: the response blob may arrive in chunks. We emit
   * text_delta events as data arrives, then a done event at the end.
   */
  private async *processResponse(
    response: {
      response?: { transformToString(): Promise<string> } | undefined;
      runtimeSessionId?: string;
      statusCode?: number;
    },
    state: AgentCoreHandleState,
  ): AsyncIterable<AcpRuntimeEvent> {
    if (!response.response) {
      yield { type: "done" };
      return;
    }

    if (response.statusCode && response.statusCode >= 400) {
      yield {
        type: "error",
        message: `AgentCore returned status ${response.statusCode}`,
        retryable: response.statusCode >= 500,
      };
      return;
    }

    try {
      const body = await response.response.transformToString();

      if (!body.trim()) {
        yield { type: "done" };
        return;
      }

      // Try to parse as JSON (agent container format: { response: "..." })
      let text: string;
      try {
        const parsed = JSON.parse(body);
        text =
          typeof parsed.response === "string"
            ? parsed.response
            : typeof parsed.text === "string"
              ? parsed.text
              : typeof parsed.message === "string"
                ? parsed.message
                : body;
      } catch {
        // Not JSON — treat the raw body as the agent's text response
        text = body;
      }

      if (text) {
        yield {
          type: "text_delta",
          text,
          stream: "output",
        };
      }

      yield { type: "done" };
    } catch (err) {
      yield {
        type: "error",
        message: `Failed to read AgentCore response: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Map AgentCore invocation errors to AcpRuntimeEvents.
   */
  private *handleInvocationError(err: unknown): Iterable<AcpRuntimeEvent> {
    const message = err instanceof Error ? err.message : String(err);
    const errName = err instanceof Error ? err.name : "";

    const isThrottled =
      errName === "ThrottlingException" ||
      message.includes("ThrottlingException") ||
      message.includes("Too Many Requests");
    const isTransient =
      errName === "ServiceUnavailableException" ||
      errName === "InternalServerException" ||
      message.includes("ServiceUnavailable") ||
      message.includes("InternalServer");
    const isNotFound =
      errName === "ResourceNotFoundException" || message.includes("ResourceNotFound");

    if (isNotFound) {
      this.healthy = false;
      yield {
        type: "error",
        message: `AgentCore Runtime not found. Check runtime ARN configuration. ${message}`,
        code: "RESOURCE_NOT_FOUND",
      };
      return;
    }

    if (isThrottled || isTransient) {
      yield {
        type: "error",
        message: `AgentCore invocation failed: ${message}`,
        code: isThrottled ? "RATE_LIMITED" : "SERVICE_UNAVAILABLE",
        retryable: true,
      };
      return;
    }

    yield {
      type: "error",
      message: `AgentCore invocation failed: ${message}`,
    };
  }
}
