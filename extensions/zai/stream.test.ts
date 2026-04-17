import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createZaiSessionIdHeaderWrapper, wrapZaiProviderStream } from "./stream.js";

type ZaiStreamApi = Extract<Api, "openai-completions">;

function buildModel(): Model<ZaiStreamApi> {
  return {
    api: "openai-completions",
    provider: "zai",
    id: "glm-5.1",
  } as Model<ZaiStreamApi>;
}

async function captureOptionsForSessionId(options: Record<string, unknown>): Promise<{
  headers?: Record<string, string>;
}> {
  let received: { headers?: Record<string, string> } | undefined;
  const baseStreamFn: StreamFn = (_model, _context, baseOptions) => {
    received = baseOptions as { headers?: Record<string, string> } | undefined;
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = createZaiSessionIdHeaderWrapper(baseStreamFn);
  await wrapped(buildModel(), { messages: [] } as Context, options as never);
  return received ?? {};
}

describe("createZaiSessionIdHeaderWrapper", () => {
  it("injects X-Session-Id when sessionId is present", async () => {
    const received = await captureOptionsForSessionId({ sessionId: "session-abc-123" });
    expect(received.headers?.["X-Session-Id"]).toBe("session-abc-123");
  });

  it("injects sessionId verbatim when it contains internal whitespace", async () => {
    const received = await captureOptionsForSessionId({ sessionId: "has spaces in middle" });
    expect(received.headers?.["X-Session-Id"]).toBe("has spaces in middle");
  });

  it("omits X-Session-Id when sessionId is undefined", async () => {
    const received = await captureOptionsForSessionId({});
    expect(received.headers).toBeUndefined();
  });

  it("omits X-Session-Id when sessionId is an empty string", async () => {
    const received = await captureOptionsForSessionId({ sessionId: "" });
    expect(received.headers).toBeUndefined();
  });

  it("omits X-Session-Id when sessionId is whitespace-only", async () => {
    const received = await captureOptionsForSessionId({ sessionId: "   \t\n  " });
    expect(received.headers?.["X-Session-Id"]).toBeUndefined();
  });

  it("omits X-Session-Id when sessionId exceeds 256 characters", async () => {
    const received = await captureOptionsForSessionId({ sessionId: "x".repeat(257) });
    expect(received.headers?.["X-Session-Id"]).toBeUndefined();
  });

  it("accepts a 256-character sessionId at the boundary", async () => {
    const sessionId = "x".repeat(256);
    const received = await captureOptionsForSessionId({ sessionId });
    expect(received.headers?.["X-Session-Id"]).toBe(sessionId);
  });

  it("omits X-Session-Id when sessionId is not a string", async () => {
    const received = await captureOptionsForSessionId({ sessionId: 12345 });
    expect(received.headers?.["X-Session-Id"]).toBeUndefined();
  });

  it("merges X-Session-Id alongside upstream headers", async () => {
    const received = await captureOptionsForSessionId({
      sessionId: "session-abc",
      headers: { "x-upstream-trace": "trace-1", authorization: "Bearer keep-me" },
    });
    expect(received.headers).toEqual({
      "x-upstream-trace": "trace-1",
      authorization: "Bearer keep-me",
      "X-Session-Id": "session-abc",
    });
  });

  it("does not mutate the original options.headers object", async () => {
    const upstreamHeaders = { "x-upstream-trace": "trace-1" };
    await captureOptionsForSessionId({ sessionId: "session-abc", headers: upstreamHeaders });
    expect(upstreamHeaders).toEqual({ "x-upstream-trace": "trace-1" });
  });
});

describe("wrapZaiProviderStream", () => {
  function buildWrapped(params: {
    extraParams?: Record<string, unknown>;
    onReceive: (
      options:
        | { headers?: Record<string, string>; onPayload?: (p: unknown, m: unknown) => unknown }
        | undefined,
    ) => void;
  }): StreamFn {
    const baseStreamFn: StreamFn = (_model, _context, baseOptions) => {
      params.onReceive(
        baseOptions as
          | {
              headers?: Record<string, string>;
              onPayload?: (p: unknown, m: unknown) => unknown;
            }
          | undefined,
      );
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = wrapZaiProviderStream({
      provider: "zai",
      modelId: "glm-5.1",
      extraParams: params.extraParams,
      streamFn: baseStreamFn,
    } as never);
    if (!wrapped) {
      throw new Error("wrapZaiProviderStream returned no wrapped stream fn");
    }
    return wrapped;
  }

  it("preserves tool_stream=true default payload patch alongside session header", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    let capturedPayload: Record<string, unknown> | undefined;
    const wrapped = buildWrapped({
      onReceive: (options) => {
        capturedHeaders = options?.headers;
        const payload: Record<string, unknown> = {};
        options?.onPayload?.(payload, buildModel());
        capturedPayload = payload;
      },
    });
    await wrapped(buildModel(), { messages: [] } as Context, { sessionId: "session-xyz" } as never);
    expect(capturedHeaders?.["X-Session-Id"]).toBe("session-xyz");
    expect(capturedPayload).toEqual({ tool_stream: true });
  });

  it("skips tool_stream payload patch when extraParams.tool_stream=false", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const wrapped = buildWrapped({
      extraParams: { tool_stream: false },
      onReceive: (options) => {
        const payload: Record<string, unknown> = {};
        options?.onPayload?.(payload, buildModel());
        capturedPayload = payload;
      },
    });
    await wrapped(buildModel(), { messages: [] } as Context, {} as never);
    expect(capturedPayload).toEqual({});
  });

  it("leaves headers untouched when no sessionId is present", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const wrapped = buildWrapped({
      onReceive: (options) => {
        capturedHeaders = options?.headers;
      },
    });
    await wrapped(buildModel(), { messages: [] } as Context, {} as never);
    expect(capturedHeaders).toBeUndefined();
  });
});
