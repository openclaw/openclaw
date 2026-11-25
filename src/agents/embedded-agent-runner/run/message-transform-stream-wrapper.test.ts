import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { MAX_VIDEO_BYTES } from "@openclaw/media-core/constants";
import { describe, expect, it, vi } from "vitest";
import {
  PROVIDER_CONTEXT_HANDOFF,
  resolveProviderContext,
  type ProviderContext,
  type ProviderStreamOptions,
} from "../../../../packages/ai/src/provider-types.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { attachRuntimePromptMediaFacts, type MediaFact } from "../../../media/media-facts.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import type { StreamFn } from "../../runtime/index.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.js";
import { hydratePromptMediaMessages, materializeProviderContext } from "./images.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";

type ProviderContextMaterializer = NonNullable<
  Parameters<typeof wrapStreamFnWithMessageTransform>[2]
>;

const PNG = {
  type: "image" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
  mimeType: "image/png",
};
const MP4 = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");
const VIDEO = { type: "video", data: MP4.toString("base64"), mimeType: "video/mp4" };
const imageFact: MediaFact = { kind: "image", contentType: "image/png" };
const videoFact = (overrides: Partial<MediaFact>): MediaFact => ({
  kind: "video",
  contentType: "video/mp4",
  ...overrides,
});
const managedVideo = (name: string, overrides: Partial<MediaFact> = {}) =>
  videoFact({ sizeBytes: MP4.length, url: `media://inbound/${name}.mp4`, ...overrides });
const imageVideoFacts = (video: Partial<MediaFact>) => [imageFact, videoFact(video), imageFact];
const text = (value: string) => ({ type: "text" as const, text: value });
const persistedVideo = (media = [videoFact({ path: "/workspace/clip.mp4" })]) => ({
  role: "user" as const,
  content: "inspect",
  timestamp: 1,
  __openclaw: { media },
});
const imagePair = (label: string, timestamp: number, media?: MediaFact[]) => ({
  role: "user" as const,
  content: [text(label), PNG, { ...PNG }],
  timestamp,
  __openclaw: {
    ...(media ? { media } : {}),
    mediaImageBlockFactIndexes: [0, 2],
    mediaImageLayout: {
      slots: [0, 2].map((factIndex) => ({ kind: "inline" as const, factIndex })),
    },
  },
});
function sandboxBridge(readFile: SandboxFsBridge["readFile"]): SandboxFsBridge {
  return {
    resolvePath: ({ filePath }: { filePath: string }) => ({
      containerPath: filePath,
      relativePath: filePath.replace(/^\//, ""),
    }),
    readFile,
  } as unknown as SandboxFsBridge;
}
const sandboxMaterializer =
  (bridge: SandboxFsBridge): ProviderContextMaterializer =>
  (input) =>
    materializeProviderContext({
      ...input,
      workspaceDir: "/workspace",
      sandbox: { root: "/workspace", bridge },
    });

describe("direct provider context handoff", () => {
  it("keeps canonical omissions while materializing persisted and current facts in order", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-video-"));
    const env = captureEnv(["OPENCLAW_STATE_DIR"]);
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const inbound = path.join(stateDir, "media", "inbound");
      await fs.mkdir(inbound, { recursive: true });
      for (const name of ["old", "recent", "steer"]) {
        await fs.writeFile(path.join(inbound, `${name}.mp4`), MP4);
      }
      const historical = imagePair(
        "historical",
        1,
        imageVideoFacts(
          managedVideo("old", {
            contentType: "application/octet-stream",
            hydrationSuppressed: true,
          }),
        ),
      );
      const recent = attachRuntimePromptMediaFacts(
        imagePair("recent", 2),
        imageVideoFacts(managedVideo("recent", { hydrationSuppressed: true })),
      );
      const steer = attachRuntimePromptMediaFacts(
        {
          role: "user" as const,
          content: [text("steer"), { ...PNG }],
          timestamp: 3,
          __openclaw: { mediaImageBlockFactIndexes: [1] },
        },
        [managedVideo("steer"), imageFact],
      );
      const missingHistorical = {
        ...persistedVideo([videoFact({ url: "media://inbound/missing.mp4" })]),
        content: "missing historical",
        timestamp: 2,
      };
      const canonicalMessages = await hydratePromptMediaMessages(
        [historical, missingHistorical, recent, steer],
        {
          workspaceDir: stateDir,
          model: { input: ["text", "image"] },
        },
      );
      const context = {
        systemPrompt: "system",
        messages: canonicalMessages,
        tools: [],
      } as Parameters<StreamFn>[1];
      const originalJson = JSON.stringify(context);
      expect(originalJson).toContain("provider does not support native video");
      const model = {
        id: "canonical",
        provider: "direct",
        api: "test",
        input: ["text", "image"],
      } as Parameters<StreamFn>[0];

      let providerContext: Promise<ProviderContext> | undefined;
      let providerOptions: ProviderStreamOptions | undefined;
      const direct = vi.fn<StreamFn>((_model, canonical, options) => {
        providerOptions = options;
        providerContext = resolveProviderContext(canonical, options);
        return createAssistantMessageEventStream();
      });
      const materialize = vi.fn<ProviderContextMaterializer>((input) =>
        materializeProviderContext({ ...input, workspaceDir: stateDir }),
      );
      const wrapped = wrapStreamFnWithMessageTransform(direct, (messages) => messages, materialize);
      void wrapped(model, context, {});
      const resolved = await providerContext;

      expect(resolved?.messages.map((message) => message.content)).toEqual([
        [text("historical"), PNG, VIDEO, { ...PNG }],
        [text("missing historical"), text("(video omitted: source unavailable)")],
        [text("recent"), PNG, VIDEO, { ...PNG }],
        [text("steer"), VIDEO, { ...PNG }],
      ]);
      for (const message of resolved?.messages.slice(2) ?? []) {
        expect(message).not.toHaveProperty("__openclaw");
        expect(Object.getOwnPropertySymbols(message)).toEqual([]);
      }
      expect(JSON.stringify(resolved)).not.toContain(stateDir);
      expect(JSON.stringify(context)).toBe(originalJson);
      await expect(providerOptions?.[PROVIDER_CONTEXT_HANDOFF]?.()).resolves.toBe(resolved);
      expect(materialize).toHaveBeenCalledTimes(1);
    } finally {
      env.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects abort after a bounded sandbox read before later dispatch", async () => {
    const readStarted = createDeferred();
    const readFinished = createDeferred<Buffer>();
    const bridge = sandboxBridge(
      vi.fn(async () => {
        readStarted.resolve();
        return await readFinished.promise;
      }),
    );
    const controller = new AbortController();
    const resolving = sandboxMaterializer(bridge)({
      context: { systemPrompt: "system", messages: [persistedVideo()], tools: [] },
      signal: controller.signal,
    });
    let dispatched = false;
    const dispatching = resolving.then(() => {
      dispatched = true;
    });
    await readStarted.promise;
    controller.abort(new Error("test abort"));
    readFinished.resolve(MP4);
    await expect(dispatching).rejects.toThrow("test abort");
    expect(dispatched).toBe(false);
  });

  it("applies one aggregate byte budget to persisted videos before reading", async () => {
    const readFile = vi.fn(async () => MP4);
    const bridge = sandboxBridge(readFile);
    const current = persistedVideo([
      videoFact({ path: "/workspace/first.mp4", sizeBytes: MP4.length }),
      videoFact({ path: "/workspace/second.mp4", sizeBytes: MAX_VIDEO_BYTES }),
    ]);
    const resolved = await sandboxMaterializer(bridge)({
      context: { systemPrompt: "system", messages: [current], tools: [] },
    });
    expect(resolved.messages[0]?.content).toEqual([
      text("inspect"),
      VIDEO,
      text("(video omitted: native video byte limit exceeded)"),
    ]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("does no I/O for a nonconsumer and reloads each opted-in physical call", async () => {
    const readFile = vi.fn(async () => MP4);
    const bridge = sandboxBridge(readFile);
    const context = { systemPrompt: "system", messages: [persistedVideo()], tools: [] };
    const model = { id: "test", provider: "test", api: "test", input: ["text", "image"] };
    const materialize = sandboxMaterializer(bridge);
    const nonconsumer = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    void wrapStreamFnWithMessageTransform(nonconsumer, (messages) => messages, materialize)(
      model as Parameters<StreamFn>[0],
      context,
      {},
    );
    expect(readFile).not.toHaveBeenCalled();

    let resolved: Promise<ProviderContext> | undefined;
    const consumer = vi.fn<StreamFn>((_model, canonical, options) => {
      resolved = resolveProviderContext(canonical, options);
      return createAssistantMessageEventStream();
    });
    const wrapped = wrapStreamFnWithMessageTransform(consumer, (messages) => messages, materialize);
    const consume = async () => {
      void wrapped(model as Parameters<StreamFn>[0], context, {});
      await resolved;
    };
    await consume();
    await consume();
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
