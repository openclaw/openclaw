import { describe, expect, it } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { appendIncognitoSystemPrompt, INCOGNITO_SYSTEM_PROMPT } from "./incognito-system-prompt.js";

describe("incognito system prompt", () => {
  it("appends the incognito instruction after existing per-session context", () => {
    expect(
      appendIncognitoSystemPrompt({
        agentId: "main",
        extraSystemPrompt: "Existing context.",
        storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
      }),
    ).toBe(`Existing context.\n\n${INCOGNITO_SYSTEM_PROMPT}`);
  });
});
