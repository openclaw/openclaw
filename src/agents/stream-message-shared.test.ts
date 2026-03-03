import { describe, expect, it } from "vitest";
import { buildStreamErrorAssistantMessage } from "./stream-message-shared.js";

const MODEL = {
  api: "responses",
  provider: "openai",
  id: "gpt-5",
};

describe("buildStreamErrorAssistantMessage", () => {
  it("stores a sanitized transcript error payload", () => {
    const message = buildStreamErrorAssistantMessage({
      model: MODEL,
      errorMessage: `<!DOCTYPE html><html><body>cf challenge</body></html>`,
    });
    expect(message.errorMessage).toBe("The AI service returned an HTML error page.");
  });
});
