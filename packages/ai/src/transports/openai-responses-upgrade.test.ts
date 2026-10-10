import path from "node:path";
import type { CacheRetention, Context, Model } from "@openclaw/llm-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../../../src/agents/sessions/session-manager.js";
import { upsertSessionEntryCore } from "../../../../src/config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../../../src/test-utils/session-state-cleanup.js";
import stableFixture from "../../test/fixtures/openai-responses-v2026.9.9.json" with { type: "json" };
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import { resolveResponsesContextUsageBoundary } from "./openai-responses-context-usage.js";

const initialHost = getAiTransportHost();
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-responses-upgrade-");

afterEach(() => {
  cleanupSessionResources();
  configureAiTransportHost(initialHost);
});

describe("Responses saved-data upgrade", () => {
  it("loads v2026.9.9 context usage, model settings, and conversation into the next request", async () => {
    // The immutable fixture was emitted by the v2026.9.9 builders and metadata writer.
    // Commit and source hashes are retained beside the old admitted wire request.
    const settings = structuredClone(stableFixture.settings);
    const savedContext = structuredClone(stableFixture.context) as Context;
    const model = settings.model as Model<"openai-responses">;
    const options = {
      ...settings.options,
      cacheRetention: settings.options.cacheRetention as CacheRetention,
    };
    const settingsBefore = JSON.stringify(settings);
    const dir = sessionDirs.make();
    const scope = {
      agentId: "main",
      sessionId: options.sessionId,
      sessionKey: "agent:main:responses-upgrade",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    // The shipped v2026.9.9 synchronous reader remains a supported SDK contract.
    const manager = SessionManager.open(scope, dir);
    for (const message of savedContext.messages) {
      manager.appendMessage(message);
    }
    const reloaded = SessionManager.open(scope, dir).buildSessionContext().messages;
    expect(reloaded).toEqual(stableFixture.context.messages);
    expect(
      resolveResponsesContextUsageBoundary(reloaded, model, options, savedContext.systemPrompt),
    ).toEqual({
      index: 3,
      totalTokens: 520,
      suffix: [],
    });

    let request: Record<string, unknown> | undefined;
    const mockFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = await new Response(init?.body).text();
      request = JSON.parse(body) as Record<string, unknown>;
      return new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_after_upgrade",
            status: "completed",
            output: [],
            usage: { input_tokens: 500, output_tokens: 20, total_tokens: 520 },
          },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => mockFetch,
    });
    const context: Context = {
      systemPrompt: savedContext.systemPrompt,
      messages: [
        ...(reloaded as Context["messages"]),
        { role: "user", content: "Continue after upgrade", timestamp: 4 },
      ],
    };
    const stream = await createOpenAIResponsesTransportStreamFn()(model, context, {
      ...options,
      apiKey: "synthetic-upgrade-key",
      transport: "sse",
    });
    const result = await stream.result();
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe("stop");
    expect(request).toMatchObject({
      model: "gpt-5.6-luna",
      prompt_cache_options: { mode: "explicit" },
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "Stable upgrade policy",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
            { type: "input_text", text: "Runtime: upgrade fixture" },
          ],
        },
        ...stableFixture.admittedRequest.input,
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue after upgrade" }],
        },
      ],
    });
    expect(request?.prompt_cache_key).toBeUndefined();
    expect(request?.prompt_cache_retention).toBeUndefined();
    expect(JSON.stringify(settings)).toBe(settingsBefore);
    expect(SessionManager.open(scope, dir).buildSessionContext().messages).toEqual(
      stableFixture.context.messages,
    );
  });
});
