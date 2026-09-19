// Google tests cover the Gemini 3.8 Live model contracts of the realtime voice provider.
import type { RealtimeVoiceTool } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildThinkingConfig,
  modelSupportsToolResultContinuation,
  supportsClientContentInterrupt,
} from "./realtime-voice-model-contract.js";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type MockGoogleLiveConnectParams = {
  model: string;
  config: Record<string, unknown>;
  callbacks: {
    onopen: () => void;
    onmessage: (message: Record<string, unknown>) => void;
    onerror: (event: { error?: unknown; message?: string }) => void;
    onclose: (event?: { code?: number; reason?: string; wasClean?: boolean }) => void;
  };
};

const { connectMock, createGoogleGenAIMock, session } = vi.hoisted(() => {
  const sessionValue = {
    close: vi.fn(),
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
  };
  const connectMockLocal = vi.fn(async (_params: MockGoogleLiveConnectParams) => sessionValue);
  const createGoogleGenAIMockLocal = vi.fn(() => ({
    authTokens: { create: vi.fn(async () => ({ name: "auth_tokens/browser-session" })) },
    live: { connect: connectMockLocal },
  }));
  return {
    connectMock: connectMockLocal,
    createGoogleGenAIMock: createGoogleGenAIMockLocal,
    session: sessionValue,
  };
});

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: createGoogleGenAIMock,
}));

const ENV_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;
let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;

function lastConnectParams(): MockGoogleLiveConnectParams {
  const params = connectMock.mock.calls.at(-1)?.[0];
  if (!params) {
    throw new Error("expected google live connect call");
  }
  return params;
}

function consultDeclaration(params: MockGoogleLiveConnectParams) {
  const config = params.config as {
    tools?: Array<{ functionDeclarations?: Array<{ behavior?: string; name?: string }> }>;
  };
  return config.tools?.[0]?.functionDeclarations?.[0];
}

function createRealtimeTool(name: string): RealtimeVoiceTool {
  return {
    type: "function",
    name,
    description: "Contract test tool",
    parameters: { type: "object", properties: {} },
  };
}

type GoogleLiveBridgeParams = Parameters<
  ReturnType<typeof buildGoogleRealtimeVoiceProvider>["createBridge"]
>[0];

function createGoogleLiveBridge(params: Partial<GoogleLiveBridgeParams> = {}) {
  const { providerConfig, ...callbacks } = params;
  return buildGoogleRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "gemini-key", ...providerConfig },
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    ...callbacks,
  });
}

async function openConfiguredBridge(params: Partial<GoogleLiveBridgeParams> = {}) {
  const bridge = createGoogleLiveBridge(params);
  await bridge.connect();
  lastConnectParams().callbacks.onopen();
  lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });
  return bridge;
}

describe("Gemini 3.8 Live model contracts", () => {
  it("classifies the 3.8 Live model ids, with or without the models/ prefix", () => {
    expect(modelSupportsToolResultContinuation("models/gemini-3.8-live")).toBe(true);
    expect(modelSupportsToolResultContinuation("models/gemini-3.8-live-extended-thinking")).toBe(
      false,
    );
    expect(supportsClientContentInterrupt("gemini-3.1-flash-live-preview")).toBe(false);
  });

  it("reserves interim tool responses and client-turn interrupts for the right models", () => {
    expect(modelSupportsToolResultContinuation("gemini-3.8-live")).toBe(true);
    expect(modelSupportsToolResultContinuation("gemini-3.8-live-extended-thinking")).toBe(false);
    expect(modelSupportsToolResultContinuation("gemini-3.1-flash-live-preview")).toBe(false);
    expect(supportsClientContentInterrupt("gemini-3.8-live-extended-thinking")).toBe(true);
    expect(supportsClientContentInterrupt("gemini-3.8-live")).toBe(false);
  });

  it("builds thinking config per model family", () => {
    expect(buildThinkingConfig({ thinkingLevel: "high" }, "gemini-3.8-live")).toBeUndefined();
    expect(buildThinkingConfig({ thinkingBudget: 512 }, "gemini-3.8-live")).toBeUndefined();
    expect(buildThinkingConfig({}, "gemini-3.8-live-extended-thinking")).toBeUndefined();
    expect(
      buildThinkingConfig({ thinkingLevel: "minimal" }, "gemini-3.8-live-extended-thinking"),
    ).toEqual({ thinkingLevel: "LOW" });
    expect(
      buildThinkingConfig({ thinkingBudget: 4_096 }, "gemini-3.8-live-extended-thinking"),
    ).toEqual({ thinkingLevel: "MEDIUM" });
    expect(
      buildThinkingConfig({ thinkingBudget: -1 }, "gemini-3.8-live-extended-thinking"),
    ).toBeUndefined();
  });
});

describe("buildGoogleRealtimeVoiceProvider with Gemini 3.8 Live", () => {
  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    connectMock.mockClear();
    createGoogleGenAIMock.mockClear();
    session.close.mockClear();
    session.sendClientContent.mockClear();
    session.sendRealtimeInput.mockClear();
    session.sendToolResponse.mockClear();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = envSnapshot[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("uses the Gemini 3.8 Live Extended Thinking contract", async () => {
    const onError = vi.fn();
    const bridge = createGoogleLiveBridge({
      providerConfig: {
        model: "gemini-3.8-live-extended-thinking",
        thinkingLevel: "high",
        thinkingBudget: 8_193,
      },
      tools: [createRealtimeTool("openclaw_agent_consult")],
      onToolCall: vi.fn(),
      onError,
    });

    // Extended Thinking rejects function response scheduling (close 1007) and abandons a
    // call after a `willContinue` interim, so the relay must send one final response.
    expect(bridge.supportsToolResultContinuation).toBe(false);
    await bridge.connect();

    const params = lastConnectParams();
    expect(params.model).toBe("gemini-3.8-live-extended-thinking");
    expect(params.config.thinkingConfig).toEqual({ thinkingLevel: "HIGH" });
    expect(consultDeclaration(params)).toMatchObject({
      name: "openclaw_agent_consult",
      behavior: "NON_BLOCKING",
    });

    params.callbacks.onmessage({
      setupComplete: { sessionId: "session-1" },
      toolCall: {
        functionCalls: [
          { id: "consult-call", name: "openclaw_agent_consult", args: { prompt: "hi" } },
        ],
      },
    });
    expect(() =>
      bridge.submitToolResult("consult-call", { status: "working" }, { willContinue: true }),
    ).toThrow("does not support continuing tool responses");
    expect(session.sendToolResponse).not.toHaveBeenCalled();

    void bridge.submitToolResult("consult-call", { text: "The meeting starts at 3." });
    expect(session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        {
          id: "consult-call",
          name: "openclaw_agent_consult",
          response: { text: "The meeting starts at 3." },
        },
      ],
    });
  });

  it("omits thinking config for Gemini 3.8 Live and keeps its async consult contract", async () => {
    const bridge = createGoogleLiveBridge({
      providerConfig: { model: "gemini-3.8-live", thinkingLevel: "high", thinkingBudget: 8_193 },
      tools: [createRealtimeTool("openclaw_agent_consult")],
      onToolCall: vi.fn(),
    });

    expect(bridge.supportsToolResultContinuation).toBe(true);
    await bridge.connect();

    const params = lastConnectParams();
    expect(params.model).toBe("gemini-3.8-live");
    expect(params.config).not.toHaveProperty("thinkingConfig");
    expect(consultDeclaration(params)).toMatchObject({
      name: "openclaw_agent_consult",
      behavior: "NON_BLOCKING",
    });
  });

  it("interrupts Gemini 3.8 Live Extended Thinking output with a client turn on barge-in", async () => {
    const bridge = await openConfiguredBridge({
      providerConfig: { model: "gemini-3.8-live-extended-thinking" },
    });

    bridge.handleBargeIn?.({ audioPlaybackActive: false });
    expect(session.sendClientContent).not.toHaveBeenCalled();

    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    expect(session.sendClientContent).toHaveBeenCalledWith({
      turns: [
        {
          role: "user",
          parts: [{ text: "[You were interrupted. Stop speaking and wait silently.]" }],
        },
      ],
      turnComplete: true,
    });
  });

  it("leaves barge-in to server-side VAD on other Gemini Live models", async () => {
    const bridge = await openConfiguredBridge({ providerConfig: { model: "gemini-3.8-live" } });

    bridge.handleBargeIn?.({ audioPlaybackActive: true, force: true });
    expect(session.sendClientContent).not.toHaveBeenCalled();
  });
});
