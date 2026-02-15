import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptParams } from "./types.js";
import { injectHistoryImagesIntoMessages } from "./attempt.js";

describe("injectHistoryImagesIntoMessages", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };

  it("injects history images and converts string content", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "See /tmp/photo.png",
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[0, [image]]]));

    expect(didMutate).toBe(true);
    expect(Array.isArray(messages[0]?.content)).toBe(true);
    const content = messages[0]?.content as Array<{ type: string; text?: string; data?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("text");
    expect(content[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("avoids duplicating existing image content", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[0, [image]]]));

    expect(didMutate).toBe(false);
    const first = messages[0];
    if (!first || !Array.isArray(first.content)) {
      throw new Error("expected array content");
    }
    expect(first.content).toHaveLength(2);
  });

  it("ignores non-user messages and out-of-range indices", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: "noop",
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[1, [image]]]));

    expect(didMutate).toBe(false);
    expect(messages[0]?.content).toBe("noop");
  });
});

describe("empty response image-strip retry", () => {
  async function runImageRetryScenario(params: {
    emptyResponsesBeforeSuccess: number;
    promptImages?: ImageContent[];
  }): Promise<{
    promptCallCount: number;
    replaceMessagesCalls: AgentMessage[][];
    usedPromptImagesByCall: boolean[];
  }> {
    const { emptyResponsesBeforeSuccess, promptImages = [] } = params;
    let promptCallCount = 0;
    const replaceMessagesCalls: AgentMessage[][] = [];
    const usedPromptImagesByCall: boolean[] = [];

    vi.resetModules();

    vi.doMock("../runs.js", () => ({
      clearActiveEmbeddedRun: vi.fn(),
      setActiveEmbeddedRun: vi.fn(),
    }));

    vi.doMock("../../pi-embedded-subscribe.js", () => ({
      subscribeEmbeddedPiSession: () => ({
        assistantTexts: [],
        toolMetas: [],
        unsubscribe: vi.fn(),
        waitForCompactionRetry: () => Promise.resolve(),
        getMessagingToolSentTexts: () => [],
        getMessagingToolSentTargets: () => [],
        didSendViaMessagingTool: () => false,
        getLastToolError: () => undefined,
        isCompacting: () => false,
        getUsageTotals: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        getCompactionCount: () => 0,
      }),
    }));

    vi.doMock("./images.js", () => ({
      detectAndLoadPromptImages: async () => ({
        images: promptImages,
        historyImagesByIndex: new Map<number, ImageContent[]>(),
      }),
    }));

    vi.doMock("../../cache-trace.js", () => ({ createCacheTrace: () => null }));
    vi.doMock("../../anthropic-payload-log.js", () => ({
      createAnthropicPayloadLogger: () => null,
    }));
    vi.doMock("../extensions.js", () => ({ buildEmbeddedExtensionPaths: () => undefined }));

    vi.doMock("../../pi-settings.js", () => ({
      ensurePiCompactionReserveTokens: () => undefined,
      resolveCompactionReserveTokensFloor: () => 0,
    }));

    vi.doMock("../google.js", () => ({
      sanitizeToolsForGoogle: ({ tools }: { tools: unknown }) => tools,
      logToolSchemasForGoogle: () => undefined,
      sanitizeSessionHistory: async ({ messages }: { messages: AgentMessage[] }) => messages,
    }));

    vi.doMock("../../session-write-lock.js", () => ({
      acquireSessionWriteLock: async () => ({ release: async () => undefined }),
    }));

    vi.doMock("../../session-file-repair.js", () => ({
      repairSessionFileIfNeeded: async () => undefined,
    }));

    vi.doMock("../session-manager-cache.js", () => ({
      prewarmSessionFile: async () => undefined,
      trackSessionManagerAccess: () => undefined,
    }));

    vi.doMock("../session-manager-init.js", () => ({
      prepareSessionManagerForRun: async () => undefined,
    }));

    vi.doMock("../../session-tool-result-guard-wrapper.js", () => ({
      guardSessionManager: (mgr: unknown) => mgr,
    }));

    vi.doMock("../../../plugins/hook-runner-global.js", () => ({
      getGlobalHookRunner: () => null,
    }));

    vi.doMock("../../skills.js", () => ({
      applySkillEnvOverrides: () => () => undefined,
      applySkillEnvOverridesFromSnapshot: () => () => undefined,
      loadWorkspaceSkillEntries: () => [],
      resolveSkillsPromptForRun: () => "",
    }));

    const messagesWithImage: AgentMessage[] = [
      { role: "user", content: "take screenshot" } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "browser", arguments: "{}" }],
        stopReason: "toolUse",
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "tc1",
        content: [
          { type: "text", text: "MEDIA:/tmp/screenshot.jpg" },
          { type: "image", data: "base64data", mimeType: "image/jpeg" },
        ],
      } as unknown as AgentMessage,
    ];

    vi.doMock("@mariozechner/pi-coding-agent", () => {
      const agent: {
        streamFn?: unknown;
        replaceMessages: (msgs: AgentMessage[]) => void;
        setSystemPrompt: (prompt: string) => void;
      } = {
        streamFn: undefined,
        replaceMessages: (msgs) => {
          replaceMessagesCalls.push([...msgs]);
          session.messages = msgs;
        },
        setSystemPrompt: () => undefined,
      };
      const session: {
        sessionId: string;
        messages: AgentMessage[];
        isStreaming: boolean;
        agent: typeof agent;
        prompt: (_prompt: string, opts?: unknown) => Promise<void>;
        steer: (text: string) => Promise<void>;
        abort: () => Promise<void>;
        dispose: () => void;
      } = {
        sessionId: "test-session-id",
        messages: [...messagesWithImage],
        isStreaming: false,
        agent,
        prompt: async (_prompt, opts) => {
          const hasPromptImages =
            typeof opts === "object" &&
            opts !== null &&
            Array.isArray((opts as { images?: unknown[] }).images) &&
            ((opts as { images?: unknown[] }).images?.length ?? 0) > 0;
          usedPromptImagesByCall.push(hasPromptImages);

          promptCallCount++;
          if (promptCallCount <= emptyResponsesBeforeSuccess) {
            session.messages.push({
              role: "assistant",
              content: [],
            } as unknown as AgentMessage);
          } else {
            session.messages.push({
              role: "assistant",
              content: [{ type: "text", text: "Here is my reply" }],
            } as unknown as AgentMessage);
          }
        },
        steer: async () => undefined,
        abort: async () => undefined,
        dispose: () => undefined,
      };

      return {
        createAgentSession: async () => ({ session }),
        SessionManager: {
          open: () => ({
            flushPendingToolResults: () => undefined,
            getLeafEntry: () => null,
          }),
        },
        SettingsManager: { create: () => ({}) },
      };
    });

    const { runEmbeddedAttempt } = await import("./attempt.js");

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-strip-test-"));
    const sessionFile = path.join(tmpRoot, "session.json");
    await fs.writeFile(sessionFile, "{}", "utf8");
    const agentDir = path.join(tmpRoot, "agent");
    const workspaceDir = path.join(tmpRoot, "workspace");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    const runParams = {
      sessionId: "sess-img",
      sessionFile,
      workspaceDir,
      agentDir,
      prompt: "what do you see?",
      provider: "openai",
      modelId: "gpt-test",
      model: { api: "openai", provider: "openai", input: ["text", "image"] },
      authStorage: {},
      modelRegistry: {},
      thinkLevel: "off",
      timeoutMs: 60_000,
      runId: "run-img",
      disableTools: true,
    } satisfies EmbeddedRunAttemptParams;

    await runEmbeddedAttempt(runParams);
    return {
      promptCallCount,
      replaceMessagesCalls,
      usedPromptImagesByCall,
    };
  }

  it("retries once with original context before stripping", async () => {
    const result = await runImageRetryScenario({ emptyResponsesBeforeSuccess: 1 });
    expect(result.promptCallCount).toBe(2);

    const lastReplace = result.replaceMessagesCalls.at(-1);
    expect(lastReplace).toBeDefined();
    const hasImage = lastReplace!.some((msg) => {
      if (!Array.isArray(msg.content)) {
        return false;
      }
      return (msg.content as { type: string }[]).some((b) => b.type === "image");
    });
    const hasPlaceholder = lastReplace!.some((msg) => {
      if (!Array.isArray(msg.content)) {
        return false;
      }
      return (msg.content as { type: string; text?: string }[]).some(
        (b) => b.type === "text" && b.text === "[image omitted]",
      );
    });

    expect(hasImage).toBe(true);
    expect(hasPlaceholder).toBe(false);
  });

  it("keeps prompt images on same-context retry", async () => {
    const promptImage: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
    const result = await runImageRetryScenario({
      emptyResponsesBeforeSuccess: 1,
      promptImages: [promptImage],
    });

    expect(result.promptCallCount).toBe(2);
    expect(result.usedPromptImagesByCall).toEqual([true, true]);
  });

  it("strips images only after two consecutive empty responses", async () => {
    const result = await runImageRetryScenario({ emptyResponsesBeforeSuccess: 2 });
    expect(result.promptCallCount).toBe(3);

    const lastReplace = result.replaceMessagesCalls.at(-1);
    expect(lastReplace).toBeDefined();
    const hasImage = lastReplace!.some((msg) => {
      if (!Array.isArray(msg.content)) {
        return false;
      }
      return (msg.content as { type: string }[]).some((b) => b.type === "image");
    });
    const hasPlaceholder = lastReplace!.some((msg) => {
      if (!Array.isArray(msg.content)) {
        return false;
      }
      return (msg.content as { type: string; text?: string }[]).some(
        (b) => b.type === "text" && b.text === "[image omitted]",
      );
    });

    expect(hasImage).toBe(false);
    expect(hasPlaceholder).toBe(true);
  });
});

describe("compaction wait abort (regression for stuck session)", () => {
  it("clears active embedded run when aborted during waitForCompactionRetry()", async () => {
    const abortController = new AbortController();

    let handleFromSet: unknown = undefined;
    const clearActiveEmbeddedRun = vi.fn();
    const setActiveEmbeddedRun = vi.fn((_sessionId: string, handle: unknown) => {
      handleFromSet = handle;
    });
    const unsubscribe = vi.fn();

    vi.resetModules();

    vi.doMock("../runs.js", () => ({
      clearActiveEmbeddedRun,
      setActiveEmbeddedRun,
    }));

    vi.doMock("../../pi-embedded-subscribe.js", () => ({
      subscribeEmbeddedPiSession: () => ({
        assistantTexts: [],
        toolMetas: [],
        unsubscribe,
        waitForCompactionRetry: () => {
          // Abort right after compaction wait begins (but keep the wait unresolved forever).
          queueMicrotask(() => abortController.abort(new Error("test abort")));
          return new Promise<void>(() => {});
        },
        getMessagingToolSentTexts: () => [],
        getMessagingToolSentTargets: () => [],
        didSendViaMessagingTool: () => false,
        getLastToolError: () => undefined,
        isCompacting: () => true,
        getUsageTotals: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        getCompactionCount: () => 0,
      }),
    }));

    vi.doMock("./images.js", () => ({
      detectAndLoadPromptImages: async () => ({
        images: [],
        historyImagesByIndex: new Map<number, ImageContent[]>(),
      }),
    }));

    vi.doMock("../../cache-trace.js", () => ({
      createCacheTrace: () => null,
    }));

    vi.doMock("../../anthropic-payload-log.js", () => ({
      createAnthropicPayloadLogger: () => null,
    }));

    vi.doMock("../extensions.js", () => ({
      buildEmbeddedExtensionPaths: () => undefined,
    }));

    vi.doMock("../../pi-settings.js", () => ({
      ensurePiCompactionReserveTokens: () => undefined,
      resolveCompactionReserveTokensFloor: () => 0,
    }));

    vi.doMock("../google.js", () => ({
      sanitizeToolsForGoogle: ({ tools }: { tools: unknown }) => tools,
      logToolSchemasForGoogle: () => undefined,
      sanitizeSessionHistory: async ({ messages }: { messages: AgentMessage[] }) => messages,
    }));

    vi.doMock("../../session-write-lock.js", () => ({
      acquireSessionWriteLock: async () => ({
        release: async () => undefined,
      }),
    }));

    vi.doMock("../../session-file-repair.js", () => ({
      repairSessionFileIfNeeded: async () => undefined,
    }));

    vi.doMock("../session-manager-cache.js", () => ({
      prewarmSessionFile: async () => undefined,
      trackSessionManagerAccess: () => undefined,
    }));

    vi.doMock("../session-manager-init.js", () => ({
      prepareSessionManagerForRun: async () => undefined,
    }));

    vi.doMock("../../session-tool-result-guard-wrapper.js", () => ({
      guardSessionManager: (mgr: unknown) => mgr,
    }));

    vi.doMock("../../../plugins/hook-runner-global.js", () => ({
      getGlobalHookRunner: () => null,
    }));

    vi.doMock("../../skills.js", () => ({
      applySkillEnvOverrides: () => () => undefined,
      applySkillEnvOverridesFromSnapshot: () => () => undefined,
      loadWorkspaceSkillEntries: () => [],
      resolveSkillsPromptForRun: () => "",
    }));

    vi.doMock("@mariozechner/pi-coding-agent", () => {
      const agent: {
        streamFn?: unknown;
        replaceMessages: (msgs: AgentMessage[]) => void;
        setSystemPrompt: (prompt: string) => void;
      } = {
        streamFn: undefined,
        replaceMessages: () => undefined,
        setSystemPrompt: () => undefined,
      };
      const session: {
        sessionId: string;
        messages: AgentMessage[];
        isStreaming: boolean;
        agent: typeof agent;
        prompt: (prompt: string, _opts?: unknown) => Promise<void>;
        steer: (text: string) => Promise<void>;
        abort: () => Promise<void>;
        dispose: () => void;
      } = {
        sessionId: "test-session-id",
        messages: [],
        isStreaming: false,
        agent,
        prompt: async () => undefined,
        steer: async () => undefined,
        abort: async () => undefined,
        dispose: () => undefined,
      };
      agent.replaceMessages = (msgs) => {
        session.messages = msgs;
      };

      return {
        createAgentSession: async () => ({ session }),
        SessionManager: {
          open: () => ({
            flushPendingToolResults: () => undefined,
            getLeafEntry: () => null,
          }),
        },
        SettingsManager: {
          create: () => ({}),
        },
      };
    });

    const { runEmbeddedAttempt } = await import("./attempt.js");

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-test-"));
    const sessionFile = path.join(tmpRoot, "session.json");
    await fs.writeFile(sessionFile, "{}", "utf8");

    const agentDir = path.join(tmpRoot, "agent");
    const workspaceDir = path.join(tmpRoot, "workspace");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    const params = {
      sessionId: "sess-1",
      sessionFile,
      workspaceDir,
      agentDir,
      prompt: "hello",
      provider: "openai",
      modelId: "gpt-test",
      model: { api: "openai", provider: "openai", input: ["text"] },
      authStorage: {},
      modelRegistry: {},
      thinkLevel: "off",
      timeoutMs: 60_000,
      runId: "run-1",
      disableTools: true,
      abortSignal: abortController.signal,
    } satisfies EmbeddedRunAttemptParams;

    const result = await runEmbeddedAttempt(params);

    expect(result.aborted).toBe(true);
    expect(setActiveEmbeddedRun).toHaveBeenCalledTimes(1);
    expect(clearActiveEmbeddedRun).toHaveBeenCalledTimes(1);
    expect(clearActiveEmbeddedRun).toHaveBeenCalledWith("sess-1", handleFromSet);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
