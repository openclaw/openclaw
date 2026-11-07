import { describe, expect, it } from "vitest";
import {
  convertToLlm,
  createCustomMessage,
} from "../../../../packages/agent-core/src/harness/messages.js";
import { buildSessionContext } from "../../../../packages/agent-core/src/harness/session/session.js";
import type { SessionTreeEntry } from "../../../../packages/agent-core/src/harness/types.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { buildRunUserTurnIdempotencyKey } from "../../../sessions/user-turn-transcript.metadata.js";
import { REALTIME_VOICE_AGENT_CONSULT_INPUT_PROVENANCE } from "../../../talk/agent-consult-tool.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createPromptCacheRequestObserver } from "../prompt-cache-request-observer.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { omitTalkConsultInputs } from "./talk-voice-history.js";

const model = { provider: "anthropic", id: "test-model", api: "anthropic-messages" } as const;
const voice = { kind: "realtime_voice", sourceChannel: "talk" } as const;
let scope = 0;

/** Stored rows in append order, plus the in-memory view of the run that is open. */
function createTalkSession(speechProvider: string) {
  const entries: SessionTreeEntry[] = [];
  let clock = 0;
  const append = (
    entry:
      | { type: "message"; message: AgentMessage }
      | {
          type: "custom_message";
          customType: string;
          content: string;
          display: boolean;
          details: unknown;
        },
  ) => {
    clock += 1;
    entries.push({
      ...entry,
      id: `entry-${clock}`,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date(clock * 1_000).toISOString(),
    } as SessionTreeEntry);
    return entries.at(-1)!;
  };
  /** Rows the browser Talk client mirrors while a consult runs; the run never sees them. */
  const speech = (role: "user" | "assistant", text: string) =>
    append({
      type: "message",
      // Speech rows carry provenance, which the shared message types do not declare.
      message: (role === "user"
        ? { role, content: [{ type: "text", text }], timestamp: clock * 1_000, provenance: voice }
        : {
            ...makeAgentAssistantMessage({
              content: [{ type: "text", text }],
              api: "realtime",
              provider: speechProvider,
              model: "realtime-voice",
              timestamp: clock * 1_000,
            }),
            provenance: voice,
          }) as unknown as AgentMessage,
    });
  const startConsult = (
    runId: string,
    prompt: string,
    { excludeFromContext = false, ordinary = false } = {},
  ) => {
    const live = buildSessionContext(entries).messages;
    const record = (entry: Parameters<typeof append>[0]) => {
      const stored = append(entry);
      live.push(
        stored.type === "custom_message"
          ? createCustomMessage(
              stored.customType,
              stored.content,
              stored.display,
              stored.details,
              stored.timestamp,
            )
          : (stored as { message: AgentMessage }).message,
      );
    };
    record({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: clock * 1_000,
        ...(ordinary
          ? {}
          : { display: false, provenance: REALTIME_VOICE_AGENT_CONSULT_INPUT_PROVENANCE }),
        ...(excludeFromContext ? { excludeFromContext: true } : {}),
        idempotencyKey: buildRunUserTurnIdempotencyKey(runId),
      } as AgentMessage,
    });
    record({
      type: "custom_message",
      customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
      content: "Temporal Context",
      display: false,
      details: {
        source: "openclaw-runtime-context",
        runtimeContextCarrier: true,
        fragments: [{ kind: "runtime-instruction", text: "Temporal Context" }],
      },
    });
    const answer = (content: AssistantMessage["content"], stopReason: "toolUse" | "stop") =>
      record({
        type: "message",
        message: makeAgentAssistantMessage({
          api: model.api,
          provider: model.provider,
          content: content as never,
          stopReason,
          timestamp: clock * 1_000,
          __openclaw: { runId },
        } as never),
      });
    const toolResult = (toolCallId: string, text: string) =>
      record({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId,
          toolName: "exec",
          content: [{ type: "text", text }],
          isError: false,
          timestamp: clock * 1_000,
          __openclaw: { runId },
        } as AgentMessage,
      });
    return { live, answer, toolResult };
  };
  return { speech, startConsult, stored: () => buildSessionContext(entries).messages };
}

function createRequests(sessionId: string) {
  const observer = createPromptCacheRequestObserver(
    { sessionId, streamStrategy: "test" },
    () => {},
  );
  return async (live: AgentMessage[]) => {
    const messages = convertToLlm(
      normalizeMessagesForLlmBoundary(live, { appendOnlyRuntimeContext: true }),
    );
    const observation = await observer.onModelRequest(model, { messages });
    observer.onModelUsage({ cacheRead: 100_000 });
    return { messages, observation };
  };
}

/** Both Talk hand-off routes: the realtime consult runner and the browser talk.client.toolCall. */
const handoffs = [
  {
    route: "consult runner",
    speechProvider: "openai",
    runIds: ["talk-realtime-consult-a", "talk-realtime-consult-b"],
  },
  {
    route: "client tool call",
    speechProvider: "google",
    runIds: [`talk-${"a".repeat(64)}`, `talk-${"b".repeat(64)}`],
  },
] as const;

async function runTwoConsults({ speechProvider, runIds }: (typeof handoffs)[number]) {
  scope += 1;
  const session = createTalkSession(speechProvider);
  const request = createRequests(`talk-consult:${scope}`);
  session.speech("user", "Can you check my list?");
  session.speech("assistant", "Sure, one moment.");

  const first = session.startConsult(runIds[0], "User request:\nCheck my list");
  await request(first.live);
  // Speech finalizes while the consult works and lands inside its stored turn.
  session.speech("user", "Can you check my list, the follow-ups one");
  first.answer([{ type: "toolCall", id: "call-a", name: "exec", arguments: {} }], "toolUse");
  first.toolResult("call-a", "3 items");
  const lastOfFirst = await request(first.live);
  session.speech("assistant", "Let me look that up.");
  first.answer([{ type: "text", text: "You have three items." }], "stop");
  session.speech("assistant", "You have three items.");
  session.speech("user", "Add one for Friday");

  const second = session.startConsult(runIds[1], "User request:\nAdd one for Friday");
  return { lastOfFirst, firstOfSecond: await request(second.live) };
}

describe("Talk consult prompt cache history", () => {
  it.each(handoffs)(
    "replays the previous $route hand-off byte-identically on the next one",
    async (handoff) => {
      await withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, async () => {
        const { lastOfFirst, firstOfSecond } = await runTwoConsults(handoff);
        expect(firstOfSecond.observation).toMatchObject({ prefixUnchanged: true, changes: null });
        expect(firstOfSecond.messages.slice(0, lastOfFirst.messages.length)).toEqual(
          lastOfFirst.messages,
        );
        const replayed = JSON.stringify(firstOfSecond.messages);
        expect(replayed).toContain("Check my list");
        expect(replayed).toContain("Add one for Friday");
        // Speech recorded during the consult follows its answer instead of being dropped.
        expect(replayed.indexOf("the follow-ups one")).toBeGreaterThan(
          replayed.indexOf("You have three items."),
        );
      });
    },
  );

  it("detects the rewrite when a consult prompt leaves later context", async () => {
    scope += 1;
    const session = createTalkSession("openai");
    const request = createRequests(`talk-consult-excluded:${scope}`);
    const first = session.startConsult("talk-realtime-consult-a", "User request:\nCheck", {
      excludeFromContext: true,
    });
    first.answer([{ type: "toolCall", id: "call-a", name: "exec", arguments: {} }], "toolUse");
    first.toolResult("call-a", "3 items");
    await request(first.live);
    first.answer([{ type: "text", text: "Three." }], "stop");
    const second = session.startConsult("talk-realtime-consult-b", "User request:\nNext");
    const { observation } = await request(second.live);
    expect(observation?.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "historyRewrite" })]),
    );
  });

  it("keeps speech in storage order around ordinary runs", () => {
    const session = createTalkSession("google");
    const run = session.startConsult("chat-run-a", "What's on today?", { ordinary: true });
    session.speech("user", "Also check tomorrow");
    run.answer([{ type: "text", text: "Nothing today." }], "stop");
    const texts = normalizeMessagesForLlmBoundary(session.stored(), {
      appendOnlyRuntimeContext: true,
    }).map((message) => JSON.stringify(message));
    const speech = texts.findIndex((text) => text.includes("Also check tomorrow"));
    expect(speech).toBeGreaterThan(-1);
    expect(speech).toBeLessThan(texts.findIndex((text) => text.includes("Nothing today.")));
  });

  it("hides a pending consult prompt from voice background before the run responds", () => {
    const session = createTalkSession("google");
    session.speech("user", "Check my list");
    session.startConsult(`talk-${"c".repeat(64)}`, "User request:\nCheck my list");
    const background = JSON.stringify(omitTalkConsultInputs(session.stored()));
    expect(background).toContain("Check my list");
    expect(background).not.toContain("User request:");
  });

  it("loads consult records saved before retention without changing them", () => {
    const session = createTalkSession("openai");
    const legacy = session.startConsult("talk-realtime-consult-old", "User request:\nOld", {
      excludeFromContext: true,
    });
    session.speech("user", "Thanks");
    legacy.answer([{ type: "text", text: "Done." }], "stop");
    const texts = JSON.stringify(
      normalizeMessagesForLlmBoundary(session.stored(), { appendOnlyRuntimeContext: true }),
    );
    expect(texts).not.toContain("User request:");
    expect(texts.indexOf("Thanks")).toBeGreaterThan(-1);
    expect(texts.indexOf("Thanks")).toBeLessThan(texts.indexOf("Done."));
  });
});
