import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { makeAgentUserMessage } from "../test-helpers/agent-message-fixtures.js";
import { createPromptCacheRequestObserver } from "./prompt-cache-request-observer.js";

afterEach(() => {
  cleanupSessionResources();
  vi.unstubAllEnvs();
});

it("ignores provenance-only envelope changes but still detects changed prompt text", async () => {
  vi.stubEnv("OPENCLAW_PROMPT_CACHE_ASSERT", "0");
  const observer = createPromptCacheRequestObserver(
    { sessionId: "provenance-only-history", streamStrategy: "test" },
    () => {},
  );
  const model = { provider: "openrouter", id: "deepseek/test", api: "openai-completions" as const };
  const provenance: (InputProvenance | undefined)[] = [
    undefined,
    { kind: "inter_session", sourceTool: "sessions_send" },
    { kind: "inter_session", sourceTool: "subagent_announce" },
    undefined,
  ];
  for (const value of provenance) {
    const message = { ...makeAgentUserMessage({ content: "Unchanged prompt" }), provenance: value };
    const request = await observer.onModelRequest(model, {
      systemPrompt: "Stable instructions",
      messages: [message],
    });
    observer.onModelUsage({ cacheRead: 8_000 });
    expect(request.changes).toBeNull();
  }
  const changed = await observer.onModelRequest(model, {
    systemPrompt: "Stable instructions",
    messages: [makeAgentUserMessage({ content: "Changed prompt" })],
  });
  expect(changed.changes).toEqual([
    { code: "historyRewrite", detail: expect.stringContaining("changed fields: content") },
  ]);
});
