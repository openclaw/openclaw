import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";
import type { AgentReasoningParam, AgentSessionEvent } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
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
const turnSchema = z.looseObject({
  id: z.string(),
  session_id: z.string(),
  subagent_id: z.string().nullable(),
  status: z.enum(["queued", "in_progress", "waiting", "completed", "failed", "cancelled"]),
  error: errorSchema.nullable(),
  usage: usageSchema.nullable(),
  agent_id: z.string().optional(),
  created_at: z.number().optional(),
  started_at: z.number().nullable().optional(),
  completed_at: z.number().nullable().optional(),
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
export type AgentsApiTurn = z.infer<typeof turnSchema>;
export type AgentsApiFunctionCall = z.infer<typeof functionCallSchema>;
export type AgentsApiFunctionDeclaration = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  defer_loading?: boolean;
};
export type AgentsApiReasoning = {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  summary?: "concise" | "detailed" | "auto" | null;
};
export type AgentsApiFunctionResult =
  | { success: true; output: string }
  | { success: false; error: string };

/** Session lifecycle uses the SDK; tool replies retain their existing request contract. */
export class AgentsApiClient {
  private readonly sessions: OpenAI["beta"]["agents"]["sessions"];

  constructor(
    private readonly apiKey: string,
    private readonly assertCurrent: () => void,
  ) {
    this.sessions = new OpenAI({
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
    }).beta.agents.sessions;
  }

  async create(
    signal: AbortSignal,
    instructions: string,
    model: string,
    reasoningEffort?: AgentReasoningParam["effort"],
    extras?: {
      functions?: AgentsApiFunctionDeclaration[];
      reasoning?: AgentsApiReasoning;
    },
  ): Promise<string> {
    const session = await this.sessions.create(
      {
        agent: {
          model,
          instructions,
          reasoning: extras?.reasoning
            ? { ...extras.reasoning, effort: reasoningEffort }
            : reasoningEffort === undefined
              ? undefined
              : { effort: reasoningEffort },
          multi_agent: { enabled: false },
          tools: [{ type: "web_search", mode: "live" }, ...(extras?.functions ?? [])],
        },
        environment: { type: "openai_hosted" },
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
    await this.input(sessionId, signal, {
      type: "agent.session.input.tool_result",
      turn_id: call.turn_id,
      call_id: call.call_id,
      ...(result.success
        ? { success: true, output: result.output }
        : { success: false, error: result.error }),
    });
  }

  async turn(sessionId: string, turnId: string, signal: AbortSignal): Promise<AgentsApiTurn> {
    const response = await this.request(
      `/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
      "GET",
      signal,
    );
    const turn = turnSchema.parse(await response.json());
    this.assertCurrent();
    if (turn.id !== turnId || turn.session_id !== sessionId || turn.subagent_id !== null) {
      throw new Error("Agents API returned a turn outside the requested root session");
    }
    return turn;
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
    await this.sessions.events.create(
      sessionId,
      {
        events: [
          {
            type: "agent.session.input.message",
            input: [{ role: "user", content: [{ type: "input_text", text }] }],
          },
        ],
        "Idempotency-Key": randomUUID(),
      },
      { signal },
    );
    this.assertCurrent();
  }

  async cancel(sessionId: string, signal: AbortSignal): Promise<void> {
    await this.sessions.events.create(
      sessionId,
      {
        events: [{ type: "agent.session.input.cancel" }],
        "Idempotency-Key": randomUUID(),
      },
      { signal },
    );
    this.assertCurrent();
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

  private async input(sessionId: string, signal: AbortSignal, event: unknown): Promise<void> {
    const response = await this.request(
      `/${encodeURIComponent(sessionId)}/events`,
      "POST",
      signal,
      {
        events: [event],
      },
    );
    await response.body?.cancel();
  }

  private async request(
    path: string,
    method: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    this.assertCurrent();
    signal.throwIfAborted();
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "OpenAI-Beta": "agents=v1",
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {}),
    };
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      this.assertCurrent();
      const guarded = await fetchWithSsrFGuard({
        url: `https://api.openai.com/v1/agents/sessions${path}`,
        signal,
        beforeRequest: this.assertCurrent,
        init: {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
      });
      response = responseWithRelease(guarded.response, guarded.release);
      if (response.status !== 503 || attempt === 2) {
        break;
      }
      await response.body?.cancel();
      await delay(1_000, undefined, { signal });
    }
    try {
      this.assertCurrent();
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (!response.ok) {
      const result: unknown = await response.json();
      const parsed = z.object({ error: errorSchema }).safeParse(result);
      throw new AgentsApiError(
        `Agents API ${method} ${path}: HTTP ${response.status}${parsed.success ? `: ${parsed.data.error.message}` : ""}`,
        {
          status: response.status,
          ...(parsed.success
            ? {
                code: parsed.data.error.code,
                type: parsed.data.error.type,
                param: parsed.data.error.param,
              }
            : {}),
        },
      );
    }
    return response;
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
