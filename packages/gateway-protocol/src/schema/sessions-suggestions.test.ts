import { describe, it } from "vitest";
import { schemaValidation } from "./protocol-validation.test-support.js";
import * as S from "./sessions-suggestions.js";

const add = schemaValidation(S.SessionSuggestionsAddParamsSchema);
const resolve = schemaValidation(S.SessionSuggestionsResolveParamsSchema);
const target = { sessionKey: "agent:main:main" };

const suggestion = {
  id: "suggestion-1",
  ...target,
  agentId: "main",
  author: { type: "human", id: "alice", label: "Alice" },
  text: "Try the smaller refactor",
  createdAt: 1,
  state: "pending",
};
const params = { ...target, sessionId: "session-main", typing: true };
const event = { ...params, agentId: "main", actor: suggestion.author, ts: 1 };

describe("session suggestions protocol", () => {
  it("accepts suggestion RPC and event payloads", () => {
    add.accepts({ ...target, text: suggestion.text });
    resolve.accepts({ ...target, id: suggestion.id, resolution: "queue" });
    schemaValidation(S.SessionSuggestionsListResultSchema).accepts({
      suggestions: [suggestion],
      role: "owner",
    });
    schemaValidation(S.SessionSuggestionEventSchema).accepts({ action: "added", suggestion });
    schemaValidation(S.SessionTypingParamsSchema).accepts(params);
    schemaValidation(S.SessionTypingEventSchema).accepts(event);
  });

  it("rejects empty suggestions and unknown resolutions", () => {
    add.rejects({ ...target, text: "" });
    resolve.rejects({ ...target, id: suggestion.id, resolution: "accept" });
  });

  it("accepts optional bounded typing previews without requiring them", () => {
    for (const [schema, base] of [
      [S.SessionTypingParamsSchema, params],
      [S.SessionTypingEventSchema, event],
    ] as const) {
      const typing = schemaValidation(schema);
      typing.accepts(
        ...[0, 4, 800].map((cursor) => Object.assign({}, base, { preview: "draft", cursor })),
        {
          ...base,
          preview: "draft",
        },
      );
      typing.rejects(...[-1, 0.5, 801, "2"].map((cursor) => Object.assign({}, base, { cursor })), {
        ...base,
        preview: "x".repeat(401),
      });
    }
  });
});
