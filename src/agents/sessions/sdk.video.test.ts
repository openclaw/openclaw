import { describe, expect, it, vi } from "vitest";
import type { ImageContent, MediaContent, Model, VideoContent } from "../../llm/types.js";
import { finalizeRuntimePromptImages } from "../../media/runtime-prompt-image-provenance.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createSyntheticSourceInfo } from "./source-info.js";

vi.mock("../../auto-reply/thinking.js", () => ({
  resolveThinkingDefaultForModel: () => "medium",
}));

const testModel: Model = {
  id: "test-video-model",
  name: "Test Video Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text", "image", "video"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};
const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
const video: VideoContent = { type: "video", data: "dmlkZW8=", mimeType: "video/mp4" };

function createNativeMediaResourceLoader(
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>>,
): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions:
      handlers.size > 0
        ? [
            {
              path: "<test-extension>",
              resolvedPath: "<test-extension>",
              sourceInfo: createSyntheticSourceInfo("<test-extension>", { source: "temporary" }),
              handlers,
              tools: new Map(),
              messageRenderers: new Map(),
              commands: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
            },
          ]
        : [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function createNativeMediaSession(options?: {
  handlers?: Map<string, Array<(...args: unknown[]) => Promise<unknown>>>;
  settingsManager?: SettingsManager;
}) {
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(testModel.provider, "test-api-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(testModel.provider, {
    api: testModel.api,
    streamSimple: vi.fn(),
  });
  return await createAgentSession({
    authStorage,
    model: testModel,
    resourceLoader: createNativeMediaResourceLoader(options?.handlers ?? new Map()),
    sessionManager: SessionManager.inMemory(),
    settingsManager: options?.settingsManager ?? SettingsManager.inMemory(),
    modelRegistry,
  });
}

describe("AgentSession native media", () => {
  it("sends ordered video and image blocks through canonical prompt media", async () => {
    const { session } = await createNativeMediaSession();
    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

    await session.prompt("describe the recording", { media: [video, image] });

    expect(prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "describe the recording" }, video, image],
      }),
    ]);
    session.dispose();
  });

  it("preserves the released images option while preferring canonical media", async () => {
    const { session } = await createNativeMediaSession();
    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

    await session.prompt("legacy image", { images: [image] });
    await session.prompt("canonical video", { media: [video], images: [image] });

    expect(prompt.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        content: [{ type: "text", text: "legacy image" }, image],
      }),
    ]);
    expect(prompt.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({
        content: [{ type: "text", text: "canonical video" }, video],
      }),
    ]);
    session.dispose();
  });

  it("preserves native video when an image-only extension transforms its images", async () => {
    const replacement: ImageContent = {
      type: "image",
      data: "cmVwbGFjZWQ=",
      mimeType: "image/jpeg",
    };
    const observed: Array<{ type: string; media?: MediaContent[]; images?: ImageContent[] }> = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "input",
        [
          async (event: unknown) => {
            observed.push(event as (typeof observed)[number]);
            return { action: "transform", text: "transformed", images: [replacement] };
          },
        ],
      ],
      [
        "before_agent_start",
        [
          async (event: unknown) => {
            observed.push(event as (typeof observed)[number]);
          },
        ],
      ],
    ]);
    const { session } = await createNativeMediaSession({ handlers });
    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

    await session.prompt("original", { media: [image, video] });

    expect(observed).toEqual([
      expect.objectContaining({ type: "input", media: [image, video], images: [image] }),
      expect.objectContaining({
        type: "before_agent_start",
        media: [replacement, video],
        images: [replacement],
      }),
    ]);
    expect(prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        content: [{ type: "text", text: "transformed" }, replacement, video],
      }),
    ]);
    session.dispose();
  });

  it("treats canonical extension media transforms as authoritative", async () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "input",
        [
          async () => ({
            action: "transform",
            text: "video only",
            media: [video],
            images: [image],
          }),
        ],
      ],
    ]);
    const { session } = await createNativeMediaSession({ handlers });
    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

    await session.prompt("original", { media: [image] });

    expect(prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        content: [{ type: "text", text: "video only" }, video],
      }),
    ]);
    session.dispose();
  });

  it("keeps ordered mixed content in extension-created user messages", async () => {
    const { session } = await createNativeMediaSession();
    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

    await session.sendUserMessage([
      { type: "text", text: "first" },
      video,
      { type: "text", text: "second" },
      image,
    ]);

    expect(prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        content: [{ type: "text", text: "first\nsecond" }, video, image],
      }),
    ]);
    session.dispose();
  });

  it("keeps video blocks while projecting mixed-media provenance onto images", async () => {
    const { session } = await createNativeMediaSession();
    const steer = vi.spyOn(session.agent, "steer").mockImplementation(() => undefined);
    const { images: media } = finalizeRuntimePromptImages<MediaContent>([
      { image: video, factIndex: null },
      { image, factIndex: 7 },
    ]);

    await session.steer("mixed attachments", media);

    expect(steer.mock.calls[0]?.[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "mixed attachments" }, video, image],
      __openclaw: { mediaImageBlockFactIndexes: [7] },
    });
    session.dispose();
  });

  it("keeps native video attachments in queued follow-up turns", async () => {
    const { session } = await createNativeMediaSession();
    const followUp = vi.spyOn(session.agent, "followUp").mockImplementation(() => undefined);

    await session.followUp("watch this", [video]);

    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "watch this" }, video],
      }),
    );
    session.dispose();
  });

  it("replays native video from persisted custom session messages", () => {
    const manager = SessionManager.inMemory();
    const content = [{ type: "text" as const, text: "recording" }, video, image];
    manager.appendCustomMessageEntry("recording", content, true);
    const header = manager.getHeader();
    if (!header) {
      throw new Error("expected session header");
    }

    const restored = SessionManager.fromEntries([header, ...manager.getEntries()]);

    expect(restored.buildSessionContext().messages).toEqual([
      expect.objectContaining({ role: "custom", customType: "recording", content }),
    ]);
  });

  it("blocks image attachments without discarding native video", async () => {
    const settingsManager = SettingsManager.inMemory({ images: { blockImages: true } });
    const { session } = await createNativeMediaSession({ settingsManager });

    const converted = await session.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "mixed" }, image, video],
        timestamp: 1,
      },
    ]);

    expect(converted).toEqual([
      expect.objectContaining({
        role: "user",
        content: [
          { type: "text", text: "mixed" },
          { type: "text", text: "Image reading is disabled." },
          video,
        ],
      }),
    ]);
    session.dispose();
  });
});
