import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

describe("extra-params: google-gemini-cli compatibility wrapper", () => {
  it("aligns User-Agent and payload keys to Gemini CLI conventions", () => {
    let capturedHeaders: Record<string, string> | undefined;
    let capturedPayload: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (_model, _context, options) => {
      capturedHeaders = options?.headers;
      const payload: Record<string, unknown> = {
        project: "my-project",
        model: "gemini-3.1-flash-preview",
        userAgent: "pi-coding-agent",
        requestId: "pi-request-123",
        request: {
          sessionId: "session-abc",
          contents: [],
        },
      };
      options?.onPayload?.(payload, _model);
      capturedPayload = payload;
      return createAssistantMessageEventStream();
    };

    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(agent, undefined, "google-gemini-cli", "gemini-3.1-flash-preview");

    const model = {
      api: "google-gemini-cli",
      provider: "google-gemini-cli",
      id: "gemini-3.1-flash-preview",
    } as Model<"google-gemini-cli">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(capturedHeaders?.["User-Agent"]).toBe(
      `GeminiCLI/openclaw/gemini-3.1-flash-preview (${process.platform}; ${process.arch})`,
    );
    expect(capturedPayload?.user_prompt_id).toBe("pi-request-123");
    expect(capturedPayload?.requestId).toBeUndefined();
    expect(capturedPayload?.userAgent).toBeUndefined();

    const request = capturedPayload?.request as Record<string, unknown> | undefined;
    expect(request?.session_id).toBe("session-abc");
    expect(request?.sessionId).toBeUndefined();
  });

  it("keeps existing user_prompt_id intact", () => {
    let capturedPayload: Record<string, unknown> | undefined;

    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        user_prompt_id: "existing-prompt-id",
        requestId: "pi-request-456",
        request: {
          sessionId: "session-xyz",
          contents: [],
        },
      };
      options?.onPayload?.(payload, _model);
      capturedPayload = payload;
      return createAssistantMessageEventStream();
    };

    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(agent, undefined, "google-gemini-cli", "gemini-3.1-pro-preview");

    const model = {
      api: "google-gemini-cli",
      provider: "google-gemini-cli",
      id: "gemini-3.1-pro-preview",
    } as Model<"google-gemini-cli">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(capturedPayload?.user_prompt_id).toBe("existing-prompt-id");
    expect(capturedPayload?.requestId).toBeUndefined();
    const request = capturedPayload?.request as Record<string, unknown> | undefined;
    expect(request?.session_id).toBe("session-xyz");
    expect(request?.sessionId).toBeUndefined();
  });
});
