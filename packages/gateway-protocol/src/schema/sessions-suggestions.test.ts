import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionSuggestionEventSchema,
  SessionSuggestionsAddParamsSchema,
  SessionSuggestionsListResultSchema,
  SessionSuggestionsResolveParamsSchema,
  SessionTypingEventSchema,
  SessionTypingParamsSchema,
} from "./sessions-suggestions.js";

function check(schema: TSchema, expected: boolean, value: unknown) {
  expect(Value.Check(schema, value)).toBe(expected);
}

const suggestion = {
  id: "suggestion-1",
  sessionKey: "agent:main:main",
  agentId: "main",
  author: { type: "human", id: "alice", label: "Alice" },
  text: "Try the smaller refactor",
  createdAt: 1,
  state: "pending",
};
const params = { sessionKey: "agent:main:main", sessionId: "session-main", typing: true };
const event = { ...params, agentId: "main", actor: suggestion.author, ts: 1 };

describe("session suggestions protocol", () => {
  it("accepts suggestion RPC and event payloads", () => {
    check(SessionSuggestionsAddParamsSchema, true, {
      sessionKey: "agent:main:main",
      text: "Try the smaller refactor",
    });
    check(SessionSuggestionsResolveParamsSchema, true, {
      sessionKey: "agent:main:main",
      id: "suggestion-1",
      resolution: "queue",
    });
    check(SessionSuggestionsListResultSchema, true, { suggestions: [suggestion], role: "owner" });
    check(SessionSuggestionEventSchema, true, { action: "added", suggestion });
    check(SessionTypingParamsSchema, true, params);
    check(SessionTypingEventSchema, true, event);
  });

  it("rejects empty suggestions and unknown resolutions", () => {
    check(SessionSuggestionsAddParamsSchema, false, { sessionKey: "agent:main:main", text: "" });
    check(SessionSuggestionsResolveParamsSchema, false, {
      sessionKey: "agent:main:main",
      id: "suggestion-1",
      resolution: "accept",
    });
  });

  it("accepts optional bounded typing previews without requiring them", () => {
    for (const cursor of [0, 4, 800]) {
      check(SessionTypingParamsSchema, true, { ...params, preview: "draft", cursor });
      check(SessionTypingEventSchema, true, { ...event, preview: "draft", cursor });
    }
    for (const cursor of [-1, 0.5, 801, "2"]) {
      check(SessionTypingParamsSchema, false, { ...params, cursor });
      check(SessionTypingEventSchema, false, { ...event, cursor });
    }
    check(SessionTypingParamsSchema, true, { ...params, preview: "draft" });
    check(SessionTypingEventSchema, true, { ...event, preview: "draft" });
    check(SessionTypingParamsSchema, false, { ...params, preview: "x".repeat(401) });
    check(SessionTypingEventSchema, false, { ...event, preview: "x".repeat(401) });
  });
});
