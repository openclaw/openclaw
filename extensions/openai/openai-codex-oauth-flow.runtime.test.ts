import { describe, expect, it } from "vitest";
import { testing } from "./openai-codex-oauth-flow.runtime.js";

describe("OpenAI Codex OAuth flow", () => {
  it("waits for Node OAuth runtime before creating an authorization flow", async () => {
    const flow = await testing.createAuthorizationFlow("openclaw-test");
    const url = new URL(flow.url);

    expect(flow.state).toMatch(/^[a-f0-9]{32}$/u);
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(url.searchParams.get("originator")).toBe("openclaw-test");
  });
});
