import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";
import type {
  AgentReasoningParam,
  AgentSessionEvent,
  HostedEnvironmentFileParam,
} from "openai/resources/beta/agents/agents";
import type { EventCreateParams } from "openai/resources/beta/agents/sessions/events";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";

const usageSchema = z.looseObject({
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number().optional(),
  input_tokens_details: z.looseObject({ cached_tokens: z.number() }).optional(),
  output_tokens_details: z.looseObject({ reasoning_tokens: z.number() }).optional(),
});
const errorSchema = z.looseObject({
  message: z.string(),
  code: z.string().nullable().optional(),
  type: z.string().optional(),
  param: z.string().nullable().optional(),
});
const functionCallSchema = z.looseObject({
  type: z.literal("function_call"),
  turn_id: z.string().min(1),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.unknown(),
});
const sessionSchema = z.looseObject({
  id: z.string(),
  status: z.enum(["idle", "in_progress", "requires_action", "failed"]),
  error: z.string().nullable(),
  usage: usageSchema.nullable().optional(),
  environment: z.looseObject({ type: z.literal("openai_hosted"), id: z.string().min(1) }),
  required_actions: z.array(
    z.union([
      functionCallSchema,
      z.looseObject({ type: z.literal("environment_connection"), environment_id: z.string() }),
    ]),
  ),
});
const artifactSchema = z.looseObject({
  id: z.string().min(1),
  object: z.literal("agent.session.artifact"),
  session_id: z.string(),
  environment_id: z.string(),
  turn_id: z.string(),
  path: z.string(),
  size_bytes: z.number().int().nonnegative().safe(),
});
const textPartSchema = z.looseObject({ type: z.string(), text: z.string().optional() });
// Validate native correlation and projection fields while retaining complete payloads.
const itemSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  role: z.string().optional(),
  phase: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  turn_id: z.string().optional(),
  content: z.array(textPartSchema).optional(),
  summary: z.array(textPartSchema).optional(),
  command: z.string().optional(),
  cwd: z.string().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  exit_code: z.number().nullable().optional(),
  name: z.string().optional(),
  call_id: z.string().optional(),
  server_label: z.string().optional(),
  arguments: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
  action: z
    .looseObject({
      type: z.string(),
      query: z.string().nullable().optional(),
      queries: z.array(z.string()).nullable().optional(),
      url: z.string().nullable().optional(),
      pattern: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
const eventSchema = z.looseObject({
  type: z.string(),
  event_id: z.string().optional(),
  session_id: z.string().optional(),
  turn_id: z.string().nullable().optional(),
  item_id: z.string().optional(),
  output_index: z.number().nullable().optional(),
  content_index: z.number().optional(),
  summary_index: z.number().optional(),
  status: z.string().nullable().optional(),
  delta: z.string().optional(),
  text: z.string().optional(),
  part: textPartSchema.optional(),
  item: itemSchema.optional(),
  usage: usageSchema.nullable().optional(),
  session: sessionSchema.optional(),
  environment: z
    .looseObject({
      id: z.string(),
      type: z.string(),
      status: z.string(),
      error: errorSchema.nullable(),
    })
    .optional(),
  turn: z
    .looseObject({
      id: z.string(),
      subagent_id: z.string().nullable(),
      session_id: z.string().optional(),
      status: z.string().optional(),
      agent_id: z.string().optional(),
      created_at: z.number().optional(),
      started_at: z.number().nullable().optional(),
      completed_at: z.number().nullable().optional(),
      error: errorSchema.nullable().optional(),
      usage: usageSchema.nullable().optional(),
    })
    .optional(),
  error: errorSchema.optional(),
});
export type AgentsApiEvent = z.infer<typeof eventSchema>;
export type AgentsApiItem = z.infer<typeof itemSchema>;
export type AgentsApiFunctionCall = z.infer<typeof functionCallSchema>;
export type AgentsApiFunctionDeclaration = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  defer_loading?: boolean;
};
export type AgentsApiInputFile = HostedEnvironmentFileParam.HostedEnvironmentFileParamInline;
export type AgentsApiArtifact = z.infer<typeof artifactSchema>;
export type AgentsApiFunctionResult =
  | { success: true; output: string }
  | { success: false; error: string };

/** The SDK owns the wire protocol; OpenClaw retains native session authority. */
export class AgentsApiClient {
  private readonly sessions: OpenAI["beta"]["agents"]["sessions"];
  private readonly environments: OpenAI["beta"]["agents"]["environments"];

  constructor(
    apiKey: string,
    private readonly assertCurrent: () => void,
  ) {
    const agents = new OpenAI({
      apiKey,
      // Ignore OPENAI_BASE_URL while retaining the SDK's official endpoint default.
      baseURL: null,
      // SDK retry backoff ignores aborts; preserve the harness's operation deadlines.
      maxRetries: 0,
      defaultHeaders: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Organization": null,
        "OpenAI-Project": null,
      },
      fetch: async (input, init) => {
        this.assertCurrent();
        const guarded = await fetchWithSsrFGuard({
          url: input instanceof Request ? input.url : String(input),
          init,
          signal: init?.signal ?? undefined,
          beforeRequest: this.assertCurrent,
        });
        const response = responseWithRelease(guarded.response, guarded.release);
        try {
          this.assertCurrent();
        } catch (error) {
          await response.body?.cancel().catch(() => undefined);
          throw error;
        }
        return response;
      },
    }).beta.agents;
    this.sessions = agents.sessions;
    this.environments = agents.environments;
  }

  async create(
    signal: AbortSignal,
    instructions: string,
    model: string,
    options?: {
      functions?: AgentsApiFunctionDeclaration[];
      files?: AgentsApiInputFile[];
      reasoning?: AgentReasoningParam;
    },
  ): Promise<string> {
    const session = await this.sessions.create(
      {
        agent: {
          model,
          instructions,
          reasoning: options?.reasoning,
          multi_agent: { enabled: false },
          tools: [{ type: "web_search", mode: "live" }, ...(options?.functions ?? [])],
        },
        environment: { type: "openai_hosted", files: options?.files ?? [] },
      },
      { signal, headers: { "Idempotency-Key": randomUUID() } },
    );
    this.assertCurrent();
    return session.id;
  }

  async setReasoningEffort(
    sessionId: string,
    effort: AgentReasoningParam["effort"],
    signal: AbortSignal,
  ): Promise<void> {
    const session = await this.sessions.update(
      sessionId,
      {},
      {
        signal,
        headers: { "Idempotency-Key": randomUUID() },
        // The API supports agent updates; this SDK version types only metadata.
        body: { agent: { reasoning: { effort: effort ?? null } } },
      },
    );
    this.assertCurrent();
    if (session.id !== sessionId) {
      throw new Error("Agents API returned a different session");
    }
  }

  async subscribe(sessionId: string, signal: AbortSignal) {
    const stream = await this.sessions.events.stream(sessionId, { signal });
    try {
      this.assertCurrent();
      signal.throwIfAborted();
    } catch (error) {
      stream.controller.abort();
      throw error;
    }
    return observeEvents(stream, signal, sessionId, this.assertCurrent);
  }

  async session(sessionId: string, signal: AbortSignal) {
    const session = await this.sessions.retrieve(sessionId, { signal });
    this.assertCurrent();
    if (session.id !== sessionId) {
      throw new Error("Agents API returned a different session");
    }
    return session;
  }

  async pendingFunctionCalls(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<AgentsApiFunctionCall[]> {
    const session = sessionSchema.parse(await this.session(sessionId, signal));
    if (session.status === "failed") {
      throw new Error(session.error ?? "Agents API session failed");
    }
    if (session.status !== "requires_action") {
      return [];
    }
    const calls: AgentsApiFunctionCall[] = [];
    for (const action of session.required_actions) {
      if (action.type !== "function_call") {
        throw new Error("Agents API hosted prototype cannot reconnect an environment_connection");
      }
      calls.push(action);
    }
    return calls;
  }

  async toolResult(
    sessionId: string,
    call: AgentsApiFunctionCall,
    result: AgentsApiFunctionResult,
    signal: AbortSignal,
  ): Promise<void> {
    await this.submitEvents(
      sessionId,
      [
        {
          type: "agent.session.input.tool_result",
          turn_id: call.turn_id,
          call_id: call.call_id,
          ...(result.success
            ? { success: true, output: result.output }
            : { success: false, error: result.error }),
        },
      ],
      signal,
    );
  }

  async turn(sessionId: string, turnId: string, signal: AbortSignal): Promise<Turn> {
    const turn = await this.sessions.turns.retrieve(turnId, { session_id: sessionId }, { signal });
    this.assertCurrent();
    if (turn.id !== turnId || turn.session_id !== sessionId || turn.subagent_id !== null) {
      throw new Error("Agents API returned a turn outside the requested root session");
    }
    return turn;
  }

  async uploadFile(
    sessionId: string,
    file: AgentsApiInputFile,
    signal: AbortSignal,
  ): Promise<void> {
    const session = await this.session(sessionId, signal);
    if (session.environment.type !== "openai_hosted") {
      throw new Error("Agents API file upload requires the session's connected hosted environment");
    }
    const retrieved = await this.environments.retrieve(session.environment.id, { signal });
    const environment = z
      .object({ id: z.string(), type: z.literal("openai_hosted"), status: z.string() })
      .parse(retrieved);
    this.assertCurrent();
    if (environment.id !== session.environment.id || environment.status !== "connected") {
      throw new Error("Agents API file upload requires the session's connected hosted environment");
    }
    const uploaded = await this.environments.files.create(session.environment.id, file, {
      signal,
      headers: { "Idempotency-Key": randomUUID() },
    });
    const saved = z
      .object({ environment_id: z.string(), path: z.string(), size_bytes: z.number() })
      .parse(uploaded);
    this.assertCurrent();
    if (
      saved.environment_id !== session.environment.id ||
      saved.path !== file.path ||
      saved.size_bytes !== Buffer.from(file.data, "base64").byteLength
    ) {
      throw new Error(
        "Agents API uploaded file did not match the requested environment, path, or size",
      );
    }
  }

  async artifacts(
    sessionId: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<AgentsApiArtifact[]> {
    const artifacts: AgentsApiArtifact[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    for (let pages = 0; pages < 100; pages++) {
      const listed = await this.sessions.artifacts.list(
        sessionId,
        { order: "asc", limit: 100, after },
        { signal },
      );
      const page = z
        .object({
          data: z.array(artifactSchema),
          has_more: z.boolean(),
        })
        .parse(listed);
      this.assertCurrent();
      if (page.data.some((artifact) => artifact.session_id !== sessionId)) {
        throw new Error("Agents API returned an artifact outside the requested session");
      }
      artifacts.push(...page.data.filter((artifact) => artifact.turn_id === turnId));
      if (!page.has_more) {
        return artifacts;
      }
      const lastId = page.data.at(-1)?.id;
      if (!lastId || seen.has(lastId)) {
        throw new Error("Agents API artifacts page has no valid continuation cursor");
      }
      after = lastId;
      seen.add(after);
    }
    throw new Error("Agents API artifact listing exceeded the pagination limit");
  }

  async artifactContent(
    sessionId: string,
    artifact: AgentsApiArtifact,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    if (
      artifact.session_id !== sessionId ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      artifact.size_bytes > maxBytes
    ) {
      throw new Error("Agents API artifact download exceeds its session or byte bounds");
    }
    const response = await this.sessions.artifacts.content(
      artifact.id,
      { session_id: sessionId },
      { signal },
    );
    if (!response.body) {
      throw new Error("Agents API artifact returned no content body");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        this.assertCurrent();
        const chunk = await reader.read();
        this.assertCurrent();
        if (chunk.done) {
          break;
        }
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes || bytes > artifact.size_bytes) {
          throw new Error("Agents API artifact content exceeded its immutable size or byte limit");
        }
        chunks.push(chunk.value);
      }
      if (bytes !== artifact.size_bytes) {
        throw new Error("Agents API artifact content did not match its immutable size");
      }
      return Buffer.concat(chunks, bytes);
    } finally {
      await closeResponseReader(reader, signal);
    }
  }

  async turns(sessionId: string, signal: AbortSignal, after?: string, latestOnly = false) {
    const turns: Turn[] = [];
    const pages = this.sessions.turns.list(
      sessionId,
      {
        order: latestOnly ? "desc" : "asc",
        limit: latestOnly ? 1 : 100,
        after,
      },
      { signal },
    );
    for await (const page of (await pages).iterPages()) {
      this.assertCurrent();
      if (page.data.some((turn) => turn.session_id !== sessionId || turn.subagent_id !== null)) {
        throw new Error("Agents API returned a turn outside the single-agent session");
      }
      turns.push(...page.data);
      if (latestOnly) {
        break;
      }
      if (page.has_more && !page.hasNextPage()) {
        throw new Error("Agents API turns page has no continuation cursor");
      }
    }
    return turns;
  }

  async message(sessionId: string, text: string, signal: AbortSignal): Promise<void> {
    await this.submitEvents(
      sessionId,
      [
        {
          type: "agent.session.input.message",
          input: [{ role: "user", content: [{ type: "input_text", text }] }],
        },
      ],
      signal,
    );
  }

  async cancel(sessionId: string, signal: AbortSignal): Promise<void> {
    await this.submitEvents(sessionId, [{ type: "agent.session.input.cancel" }], signal);
    // The input acknowledgement is not a settlement barrier for hosted work.
    while (true) {
      const session = await this.session(sessionId, signal);
      if (session.status === "idle" || session.status === "failed") {
        return;
      }
      await delay(500, undefined, { signal });
    }
  }

  async items(
    sessionId: string,
    turnId: string | undefined,
    signal: AbortSignal,
  ): Promise<AgentsApiItem[]> {
    const items: AgentsApiItem[] = [];
    const pages = this.sessions.items.list(sessionId, { order: "asc", limit: 100 }, { signal });
    for await (const page of (await pages).iterPages()) {
      this.assertCurrent();
      items.push(
        ...page.data
          .filter((item) => turnId === undefined || item.turn_id === turnId)
          .map((item) => itemSchema.parse(item)),
      );
      if (page.has_more && !page.hasNextPage()) {
        throw new Error("Agents API items page has no continuation cursor");
      }
    }
    return items;
  }

  private async submitEvents(
    sessionId: string,
    events: EventCreateParams["events"],
    signal: AbortSignal,
  ): Promise<void> {
    // Retry this submission, not a new turn: its payload and key must stay together.
    const params: EventCreateParams = { events, "Idempotency-Key": randomUUID() };
    await retryAsync(
      async () => {
        signal.throwIfAborted();
        this.assertCurrent();
        await this.sessions.events.create(sessionId, params, { signal });
      },
      {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 5_000,
        jitter: 0.25,
        shouldRetry: (error) =>
          !signal.aborted &&
          error instanceof OpenAI.APIError &&
          error.status !== undefined &&
          error.status >= 500 &&
          error.status < 600 &&
          error.headers?.get("x-should-retry") !== "false",
        sleep: (ms) => sleepWithAbort(ms, signal),
      },
    );
    this.assertCurrent();
  }
}

/** Customer-safe native failure facts remain available to host result classification. */
export class AgentsApiError extends Error {
  readonly code: string | null | undefined;
  readonly status: number | undefined;
  readonly type: string | undefined;
  readonly param: string | null | undefined;

  constructor(
    message: string,
    details: {
      code?: string | null;
      status?: number;
      type?: string;
      param?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "AgentsApiError";
    this.code = details.code;
    this.status = details.status;
    this.type = details.type;
    this.param = details.param;
  }
}

export function isAgentsApiTerminalTurn(status?: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

async function* observeEvents(
  stream: AsyncIterable<AgentSessionEvent>,
  signal: AbortSignal,
  sessionId: string,
  assertCurrent: () => void,
): AsyncGenerator<AgentsApiEvent> {
  for await (const rawEvent of stream) {
    signal.throwIfAborted();
    assertCurrent();
    const event = eventSchema.parse(rawEvent);
    if (
      (event.session_id && event.session_id !== sessionId) ||
      (event.session && event.session.id !== sessionId) ||
      (event.turn?.session_id && event.turn.session_id !== sessionId)
    ) {
      throw new Error("Agents API returned an event outside the requested session");
    }
    yield event;
  }
  signal.throwIfAborted();
}

async function closeResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  try {
    await reader.cancel();
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    reader.releaseLock();
  }
  signal.throwIfAborted();
}
