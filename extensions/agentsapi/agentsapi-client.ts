import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";

const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  input_tokens_details: z.object({ cached_tokens: z.number() }).optional(),
});
const errorSchema = z.object({ message: z.string() });
const functionCallSchema = z.object({
  type: z.literal("function_call"),
  turn_id: z.string().min(1),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.unknown(),
});
const sessionSchema = z.object({
  id: z.string(),
  status: z.enum(["idle", "in_progress", "requires_action", "failed"]),
  error: z.string().nullable(),
  environment: z.object({ type: z.literal("openai_hosted"), id: z.string().min(1) }),
  required_actions: z.array(
    z.union([
      functionCallSchema,
      z.object({ type: z.literal("environment_connection"), environment_id: z.string() }),
    ]),
  ),
});
const artifactSchema = z.object({
  id: z.string().min(1),
  object: z.literal("agent.session.artifact"),
  session_id: z.string(),
  environment_id: z.string(),
  turn_id: z.string(),
  path: z.string(),
  size_bytes: z.number().int().nonnegative().safe(),
});
const turnSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  subagent_id: z.string().nullable(),
  status: z.enum(["queued", "in_progress", "waiting", "completed", "failed", "cancelled"]),
  error: errorSchema.nullable(),
  usage: usageSchema.nullable(),
});
const itemSchema = z.object({
  id: z.string(),
  type: z.string(),
  role: z.string().optional(),
  phase: z.string().nullable().optional(),
  status: z.string().optional(),
  turn_id: z.string().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
});
const eventSchema = z.object({
  type: z.string(),
  session_id: z.string().optional(),
  turn_id: z.string().nullable().optional(),
  item_id: z.string().optional(),
  content_index: z.number().optional(),
  delta: z.string().optional(),
  text: z.string().optional(),
  item: itemSchema.optional(),
  turn: z
    .object({
      id: z.string(),
      subagent_id: z.string().nullable(),
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
export type AgentsApiInputFile = { type: "inline"; path: string; data: string };
export type AgentsApiArtifact = z.infer<typeof artifactSchema>;
export type AgentsApiFunctionResult =
  | { success: true; output: string }
  | { success: false; error: string };

/** The MVP intentionally fixes endpoint, agent settings, and execution placement. */
export class AgentsApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly assertCurrent: () => void,
  ) {}

  async create(
    signal: AbortSignal,
    instructions: string,
    model: string,
    extras?: { functions?: AgentsApiFunctionDeclaration[]; files?: AgentsApiInputFile[] },
  ): Promise<string> {
    const response = await this.request("", "POST", signal, {
      agent: {
        model,
        instructions,
        reasoning: { effort: "low" },
        multi_agent: { enabled: false },
        tools: extras?.functions ?? [],
      },
      environment: { type: "openai_hosted", files: extras?.files ?? [] },
    });
    const result = z.object({ id: z.string() }).parse(await response.json());
    this.assertCurrent();
    return result.id;
  }

  async subscribe(sessionId: string, signal: AbortSignal) {
    const response = await this.request(
      `/${encodeURIComponent(sessionId)}/events?stream=true`,
      "GET",
      signal,
    );
    if (!response.body) {
      throw new Error("Agents API returned an empty event stream");
    }
    return readEvents(response.body, signal);
  }

  async session(sessionId: string, signal: AbortSignal) {
    const response = await this.request(`/${encodeURIComponent(sessionId)}`, "GET", signal);
    const session = sessionSchema.parse(await response.json());
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
    const session = await this.session(sessionId, signal);
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

  async uploadFile(
    sessionId: string,
    file: AgentsApiInputFile,
    signal: AbortSignal,
  ): Promise<void> {
    const session = await this.session(sessionId, signal);
    const environmentPath = `/agents/environments/${encodeURIComponent(session.environment.id)}`;
    const response = await this.requestResource(environmentPath, "GET", signal);
    const environment = z
      .object({ id: z.string(), type: z.literal("openai_hosted"), status: z.string() })
      .parse(await response.json());
    this.assertCurrent();
    if (environment.id !== session.environment.id || environment.status !== "connected") {
      throw new Error("Agents API file upload requires the session's connected hosted environment");
    }
    const uploaded = await this.requestResource(`${environmentPath}/files`, "POST", signal, file);
    const saved = z
      .object({ environment_id: z.string(), path: z.string(), size_bytes: z.number() })
      .parse(await uploaded.json());
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
      const query = new URLSearchParams({ order: "asc", limit: "100" });
      if (after) {
        query.set("after", after);
      }
      const response = await this.request(
        `/${encodeURIComponent(sessionId)}/artifacts?${query}`,
        "GET",
        signal,
      );
      const page = z
        .object({
          data: z.array(artifactSchema),
          has_more: z.boolean(),
          last_id: z.string().nullable(),
        })
        .parse(await response.json());
      this.assertCurrent();
      if (page.data.some((artifact) => artifact.session_id !== sessionId)) {
        throw new Error("Agents API returned an artifact outside the requested session");
      }
      artifacts.push(...page.data.filter((artifact) => artifact.turn_id === turnId));
      if (!page.has_more) {
        return artifacts;
      }
      if (!page.last_id || seen.has(page.last_id)) {
        throw new Error("Agents API artifacts page has no valid continuation cursor");
      }
      after = page.last_id;
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
    const response = await this.request(
      `/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifact.id)}/content`,
      "GET",
      signal,
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
    const turns: AgentsApiTurn[] = [];
    let cursor = after;
    do {
      const query = new URLSearchParams({
        order: latestOnly ? "desc" : "asc",
        limit: latestOnly ? "1" : "100",
      });
      if (cursor) {
        query.set("after", cursor);
      }
      const response = await this.request(
        `/${encodeURIComponent(sessionId)}/turns?${query}`,
        "GET",
        signal,
      );
      const page = z
        .object({
          data: z.array(turnSchema),
          has_more: z.boolean(),
          last_id: z.string().nullable(),
        })
        .parse(await response.json());
      this.assertCurrent();
      if (page.data.some((turn) => turn.session_id !== sessionId || turn.subagent_id !== null)) {
        throw new Error("Agents API returned a turn outside the single-agent session");
      }
      turns.push(...page.data);
      if (latestOnly) {
        break;
      }
      cursor = page.has_more ? (page.last_id ?? undefined) : undefined;
      if (page.has_more && !cursor) {
        throw new Error("Agents API turns page has no continuation cursor");
      }
    } while (cursor);
    return turns;
  }

  async message(sessionId: string, text: string, signal: AbortSignal): Promise<void> {
    await this.input(sessionId, signal, {
      type: "agent.session.input.message",
      input: [{ role: "user", content: [{ type: "input_text", text }] }],
    });
  }

  async cancel(sessionId: string, signal: AbortSignal): Promise<void> {
    await this.input(sessionId, signal, { type: "agent.session.input.cancel" });
    // The input acknowledgement is not a settlement barrier for hosted work.
    while (true) {
      const response = await this.request(`/${encodeURIComponent(sessionId)}`, "GET", signal);
      const session = z.object({ status: z.string() }).parse(await response.json());
      this.assertCurrent();
      if (session.status === "idle" || session.status === "failed") {
        return;
      }
      await delay(500, undefined, { signal });
    }
  }

  async items(sessionId: string, turnId: string, signal: AbortSignal): Promise<AgentsApiItem[]> {
    const items: AgentsApiItem[] = [];
    let after: string | undefined;
    do {
      const query = new URLSearchParams({ order: "asc", limit: "100" });
      if (after) {
        query.set("after", after);
      }
      const response = await this.request(
        `/${encodeURIComponent(sessionId)}/items?${query}`,
        "GET",
        signal,
      );
      const page = z
        .object({
          data: z.array(itemSchema),
          has_more: z.boolean(),
          last_id: z.string().nullable(),
        })
        .parse(await response.json());
      this.assertCurrent();
      items.push(...page.data.filter((item) => item.turn_id === turnId));
      after = page.has_more ? (page.last_id ?? undefined) : undefined;
      if (page.has_more && !after) {
        throw new Error("Agents API items page has no continuation cursor");
      }
    } while (after);
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
    return this.requestResource(`/agents/sessions${path}`, method, signal, body);
  }

  private async requestResource(
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
      Accept: "text/event-stream, application/json, application/octet-stream",
      ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {}),
    };
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      this.assertCurrent();
      const guarded = await fetchWithSsrFGuard({
        url: `https://api.openai.com/v1${path}`,
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
      throw new Error(
        `Agents API ${method} ${path}: HTTP ${response.status}${parsed.success ? `: ${parsed.data.error.message}` : ""}`,
      );
    }
    return response;
  }
}

async function* readEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<AgentsApiEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 2_000_000) {
        throw new Error("Agents API event exceeded the stream buffer limit");
      }
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/u.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") {
          yield eventSchema.parse(JSON.parse(data));
        }
      }
    }
  } finally {
    await closeResponseReader(reader, signal);
  }
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
}
