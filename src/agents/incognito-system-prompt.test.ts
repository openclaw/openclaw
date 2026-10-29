import { describe, expect, it } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { appendIncognitoSystemPrompt } from "./incognito-system-prompt.js";

describe("incognito system prompt", () => {
  it("preserves existing context bytes before appending the incognito instruction", () => {
    expect(
      appendIncognitoSystemPrompt({
        agentId: "main",
        extraSystemPrompt: "Existing context.\n",
        storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
      }),
    ).toBe(
      "Existing context.\n\n\nThis chat is incognito; do not store its conversation content in memory files or long-term notes.",
    );
  });
});
