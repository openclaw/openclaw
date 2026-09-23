import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";
import type { AgentSessionEvent, AgentSessionItem } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

/** The SDK owns the wire protocol; OpenClaw retains native session authority. */
export class AgentsApiClient {
  private readonly sessions: OpenAI["beta"]["agents"]["sessions"];

  constructor(
    apiKey: string,
    private readonly assertCurrent: () => void,
  ) {
    this.sessions = new OpenAI({
      apiKey,
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

  async create(signal: AbortSignal, instructions: string, model: string): Promise<string> {
    const session = await this.sessions.create(
      {
        agent: {
          model,
          instructions,
          reasoning: { effort: "low" },
          multi_agent: { enabled: false },
        },
        environment: { type: "openai_hosted" },
      },
      { signal, headers: { "Idempotency-Key": randomUUID() } },
    );
    this.assertCurrent();
    return session.id;
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
    return observeEvents(stream, signal, this.assertCurrent);
  }

  async session(sessionId: string, signal: AbortSignal) {
    const session = await this.sessions.retrieve(sessionId, { signal });
    this.assertCurrent();
    if (session.id !== sessionId) {
      throw new Error("Agents API returned a different session");
    }
    return session;
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

  async items(sessionId: string, turnId: string, signal: AbortSignal): Promise<AgentSessionItem[]> {
    const items: AgentSessionItem[] = [];
    const pages = this.sessions.items.list(sessionId, { order: "asc", limit: 100 }, { signal });
    for await (const page of (await pages).iterPages()) {
      this.assertCurrent();
      items.push(...page.data.filter((item) => item.turn_id === turnId));
      if (page.has_more && !page.hasNextPage()) {
        throw new Error("Agents API items page has no continuation cursor");
      }
    }
    return items;
  }
}

async function* observeEvents(
  stream: AsyncIterable<AgentSessionEvent>,
  signal: AbortSignal,
  assertCurrent: () => void,
) {
  for await (const event of stream) {
    signal.throwIfAborted();
    assertCurrent();
    yield event;
  }
  signal.throwIfAborted();
}
