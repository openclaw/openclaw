import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDedicatedClient,
  denyAllPermissionHandler,
  getSdkClient,
  __resetSdkClientForTests,
  type SdkModule,
} from "./sdk-client.js";

/**
 * Build a fake SDK module whose responses match the real @github/copilot-sdk shapes.
 *
 * Evidence (captured 2026-04-20 from real SDK v0.2.2):
 *
 *   listModels() → [{ id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6",
 *     capabilities: { family: "claude-sonnet-4.6", limits: {...}, supports: {...} },
 *     policy: { state: "enabled", terms: "..." },
 *     billing: { is_premium: true, multiplier: 1, restricted_to: [...] },
 *     supportedReasoningEfforts: ["low","medium","high"],
 *     defaultReasoningEffort: "medium" }, ...]
 *
 *   sendAndWait() → { type: "assistant.message", data: { messageId, content,
 *     toolRequests: [], interactionId, reasoningOpaque?, reasoningText?,
 *     outputTokens, requestId },
 *     id: "uuid", timestamp: "iso8601", parentId: "uuid"|null }
 */
function buildFakeSdk(): {
  module: SdkModule;
  listModels: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  sessionSendAndWait: ReturnType<typeof vi.fn>;
  sessionDispose: ReturnType<typeof vi.fn>;
} {
  // Matches real AssistantMessageEvent shape from @github/copilot-sdk
  const sessionSendAndWait = vi.fn(async ({ prompt }: { prompt: string }) => ({
    type: "assistant.message" as const,
    data: {
      messageId: "fake-msg-001",
      content: `sdk-reply:${prompt}`,
      toolRequests: [],
      outputTokens: 10,
      requestId: "FAKE:000000:0000000:0000000:00000000",
    },
    id: "fake-event-001",
    timestamp: new Date().toISOString(),
    parentId: null,
  }));
  const sessionDispose = vi.fn(async () => undefined);
  const createSession = vi.fn(async () => ({
    sendAndWait: sessionSendAndWait,
    dispose: sessionDispose,
  }));
  // Matches real ModelInfo shape from @github/copilot-sdk
  const listModels = vi.fn(async () => [
    {
      id: "gpt-5",
      name: "GPT-5",
      capabilities: {
        family: "gpt-5",
        limits: { max_context_window_tokens: 128000 },
        supports: { tool_calls: true, streaming: true },
        type: "chat",
      },
    },
  ]);

  const module: SdkModule = {
    CopilotClient: class {
      start = vi.fn(async () => undefined);
      listModels = listModels;
      createSession = createSession;
      dispose = vi.fn(async () => undefined);
    } as unknown as SdkModule["CopilotClient"],
  };

  return { module, listModels, createSession, sessionSendAndWait, sessionDispose };
}

describe("sdk-client wrapper", () => {
  afterEach(() => {
    __resetSdkClientForTests();
  });

  it("denyAllPermissionHandler returns denied-by-rules", () => {
    expect(denyAllPermissionHandler()).toEqual({ kind: "denied-by-rules", rules: [] });
  });

  it("forwards listModels from the underlying SDK", async () => {
    const fake = buildFakeSdk();
    const client = await getSdkClient({ sdkFactory: async () => fake.module });
    expect(await client.listModels()).toEqual([{ id: "gpt-5", name: "GPT-5" }]);
    expect(fake.listModels).toHaveBeenCalledOnce();
  });

  it("wires runPrompt through a session and disposes the session after use", async () => {
    const fake = buildFakeSdk();
    const client = await getSdkClient({ sdkFactory: async () => fake.module });

    const result = await client.runPrompt({ model: "gpt-5", prompt: "hello" });
    expect(result.content).toBe("sdk-reply:hello");
    expect(fake.createSession).toHaveBeenCalledOnce();
    const createArg = fake.createSession.mock.calls[0][0];
    expect(createArg.model).toBe("gpt-5");
    expect(createArg.onPermissionRequest()).toEqual({ kind: "denied-by-rules", rules: [] });
    expect(fake.sessionDispose).toHaveBeenCalledOnce();
  });

  it("reuses the cached client when options are unchanged", async () => {
    const fake = buildFakeSdk();
    const factory = vi.fn(async () => fake.module);
    const a = await getSdkClient({ sdkFactory: factory });
    const b = await getSdkClient({ sdkFactory: factory });
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("rebuilds the client when cliPath changes", async () => {
    const first = buildFakeSdk();
    const second = buildFakeSdk();
    const factoryFirst = vi.fn(async () => first.module);
    const factorySecond = vi.fn(async () => second.module);

    const a = await getSdkClient({ cliPath: "/a", sdkFactory: factoryFirst });
    const b = await getSdkClient({ cliPath: "/b", sdkFactory: factorySecond });
    expect(a).not.toBe(b);
    expect(factoryFirst).toHaveBeenCalledOnce();
    expect(factorySecond).toHaveBeenCalledOnce();
  });

  it("disposes sessions even when sendAndWait throws", async () => {
    const fake = buildFakeSdk();
    fake.sessionSendAndWait.mockImplementationOnce(async () => {
      throw new Error("session boom");
    });
    const client = await getSdkClient({ sdkFactory: async () => fake.module });
    await expect(client.runPrompt({ model: "gpt-5", prompt: "x" })).rejects.toThrow("session boom");
    expect(fake.sessionDispose).toHaveBeenCalledOnce();
  });

  it("rejects when start() exceeds the timeout", async () => {
    const hangingModule: SdkModule = {
      CopilotClient: class {
        // start() never resolves — simulates a CLI that spawns but never connects
        start = () => new Promise<void>(() => {});
        listModels = vi.fn(async () => []);
        createSession = vi.fn(async () => ({ sendAndWait: vi.fn() }));
      } as unknown as SdkModule["CopilotClient"],
    };
    await expect(
      getSdkClient({ sdkFactory: async () => hangingModule, startTimeoutMs: 100 }),
    ).rejects.toThrow(/timed out/);
  });

  it("createDedicatedClient returns a fresh non-singleton client each time", async () => {
    const fake = buildFakeSdk();
    const factory = vi.fn(async () => fake.module);

    // Get the singleton first.
    const singleton = await getSdkClient({ sdkFactory: factory });

    // Create two dedicated clients with the same options.
    const dedicatedA = await createDedicatedClient({ sdkFactory: factory });
    const dedicatedB = await createDedicatedClient({ sdkFactory: factory });

    // Each call creates a distinct object.
    expect(dedicatedA).not.toBe(dedicatedB);

    // Neither is the singleton.
    expect(dedicatedA).not.toBe(singleton);
    expect(dedicatedB).not.toBe(singleton);

    // Closing one dedicated client does not affect the other or the singleton.
    await dedicatedA.close();
    // Singleton still works.
    expect(await singleton.listModels()).toEqual([{ id: "gpt-5", name: "GPT-5" }]);
    // Other dedicated client still works.
    expect(await dedicatedB.listModels()).toEqual([{ id: "gpt-5", name: "GPT-5" }]);

    // After closing dedicatedA, the singleton is still returned by getSdkClient.
    const singletonAgain = await getSdkClient({ sdkFactory: factory });
    expect(singletonAgain).toBe(singleton);

    await dedicatedB.close();
  });
});
