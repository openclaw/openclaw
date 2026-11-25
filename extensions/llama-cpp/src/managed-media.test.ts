import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const install = vi.hoisted(() => vi.fn());

vi.mock("./llama-server-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llama-server-install.js")>()),
  ensureLlamaServerInstalled: install,
}));

import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { buildLlamaCppModel } from "./defaults.js";
import { selectLlamaServerAsset } from "./llama-server-assets.js";
import {
  ensureManagedLlamaServerForChat,
  prepareManagedLlamaServer,
  resolveLlamaCppPresetPath,
} from "./managed-server.js";
import * as mediaCatalog from "./media-catalog.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const activeChat = "version = 1\n\n[chat]\nmodel = /models/chat.gguf\n";
const visionModel = {
  id: "vision",
  path: "/models/vision.gguf",
  projectorPath: "/models/mmproj.gguf",
};
type ChatRequest = Parameters<typeof ensureManagedLlamaServerForChat>[0];
const recipe = mediaCatalog.LLAMA_CPP_MEDIA_RECIPES.find((entry) => entry.capability === "ocr")!;
let tempRoot: string;
let presetPath: string;
let command: string;
let localService: { command: string; args: string[] };
let provider: ChatRequest["provider"];

function mediaRequest(modelParams: Record<string, unknown> = {}): ChatRequest {
  return {
    provider,
    model: {
      id: recipe.id,
      params: {
        modelPath: recipe.model.source,
        mmprojPath: recipe.projector.source,
        ...modelParams,
      },
    },
  };
}

function prepareMedia(options: Partial<Parameters<typeof prepareManagedLlamaServer>[0]> = {}) {
  return prepareManagedLlamaServer({
    chatModel: { mode: "preserve" },
    mediaModels: [visionModel],
    isolated: true,
    modelsMax: 1,
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

beforeEach(async () => {
  tempRoot = tempDirs.make("llama-server-media-");
  presetPath = path.join(tempRoot, "models.ini");
  command = path.join(tempRoot, "llama-server");
  localService = { command, args: ["--models-preset", presetPath] };
  provider = {
    baseUrl: "http://127.0.0.1:19432/v1",
    localService,
    models: [],
    params: { modelCacheDir: tempRoot, mediaModels: { ocr: recipe.id, vision: "vision" } },
  };
  install.mockResolvedValue({ command });
  await fs.writeFile(command, "test runtime");
});

function useSmallMediaArtifacts(projectorPayload = "GGUF") {
  const resolveArtifact = mediaCatalog.resolveLlamaCppMediaArtifact;
  // Keep real curated identities and replace only bytes/digests at the artifact boundary.
  vi.spyOn(mediaCatalog, "resolveLlamaCppMediaArtifact").mockImplementation((source) => {
    const artifact = resolveArtifact(source);
    const payload = source === recipe.projector.source ? projectorPayload : "GGUF";
    const identity = {
      expectedSize: Buffer.byteLength(payload),
      expectedSha256: createHash("sha256").update(payload).digest("hex"),
    };
    return artifact ? { ...artifact, ...identity } : undefined;
  });
}

it("isolates media verification and pins both model and projector to none", async () => {
  const header = "version = 1\r\n; operator defaults\r\n[*]\r\nthreads = 6\r\n\r\n";
  const chat = "[chat]\r\n; chat stays available\r\nmodel = /models/chat.gguf\r\nn-gpu-layers = 7";
  const custom = "[custom]\r\nmodel = /models/custom.gguf\r\nctx-size = 8192";
  const embedding =
    "[embeddinggemma-300m-qat-q8_0]\r\nmodel = /models/embedding.gguf\r\nembedding = true\r\npooling = mean";
  const oldMedia =
    "[ocr]\r\nmm = /models/old-projector.gguf ; projector comment\r\nLLAMA_ARG_IMAGE_MAX_TOKENS = 4096\r\nnp = 8\r\ndev = CUDA0,CUDA1\r\nmmdev = CUDA0\r\nsm = layer\r\nload-on-startup = true";
  const active = header + [chat, custom, oldMedia, embedding].join("\r\n\r\n") + "\r\n";
  await fs.writeFile(presetPath, active);
  const asset = selectLlamaServerAsset("linux", "x64");
  const signal = new AbortController().signal;
  const activeService = {
    command: path.join(tempRoot, "old-server"),
    args: [
      ..."--host=0.0.0.0 --port 19431".split(" "),
      `--models-preset=${presetPath}`,
      ..."--models-max 2 --threads 6 --metrics".split(" "),
    ],
    healthUrl: "http://127.0.0.1:19431/health",
  };
  const candidate = await prepareMedia({
    mediaModels: ["ocr", "vision"].map((id) => ({
      id,
      path: `/models/${id}.gguf`,
      projectorPath: `/models/${id}-projector.gguf`,
      device: "none",
    })),
    asset,
    localService: activeService,
    port: 19435,
    signal,
  });

  expect(candidate).toMatchObject({
    command,
    baseUrl: "http://127.0.0.1:19435/v1",
    healthUrl: "http://127.0.0.1:19435/health",
  });
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ asset, signal }));
  const candidatePreset = resolveLlamaCppPresetPath(candidate)!;
  expect(candidatePreset).not.toBe(presetPath);
  expect(candidate.args).toEqual([
    ..."--threads 6 --metrics --host 127.0.0.1 --port 19435 --models-preset".split(" "),
    candidatePreset,
    "--models-max",
    "1",
  ]);
  expect(await fs.readFile(presetPath, "utf8")).toBe(active);
  const prepared = await fs.readFile(candidatePreset, "utf8");
  expect(prepared.startsWith(header)).toBe(true);
  for (const retained of [chat, custom, embedding]) {
    expect(prepared).toContain(retained);
  }
  expect(prepared).toContain("mmproj = /models/vision-projector.gguf");
  expect(prepared).toContain("mmproj = /models/ocr-projector.gguf ; projector comment");
  expect(prepared.match(/^device = none$/gm)).toHaveLength(2);
  expect(prepared.match(/^mmproj-device = none$/gm)).toHaveLength(2);
  expect(prepared.match(/^split-mode = none$/gm)).toHaveLength(2);
  expect(prepared.match(/^load-on-startup = false$/gm)).toHaveLength(2);
  expect(prepared.match(/^parallel = 1$/gm)).toHaveLength(2);
  expect(prepared).not.toMatch(/^(?:mm|dev|mmdev|sm|np|LLAMA_ARG_IMAGE_MAX_TOKENS) =/m);
});

it("prepares media-only presets without inventing an embedding model", async () => {
  const candidate = await prepareMedia({ port: 19437 });
  const preset = await fs.readFile(resolveLlamaCppPresetPath(candidate)!, "utf8");
  expect(preset).toContain("[vision]");
  expect(preset).not.toContain("embedding");
  const modelsMax = candidate.args.indexOf("--models-max");
  expect(candidate.args.slice(modelsMax, modelsMax + 2)).toEqual(["--models-max", "1"]);
});

it("stops cancelled media preparation before publishing a preset", async () => {
  const controller = new AbortController();
  install.mockImplementationOnce(() => {
    controller.abort(new Error("setup cancelled"));
    return { command };
  });
  await expect(prepareMedia({ signal: controller.signal })).rejects.toBe(controller.signal.reason);
  expect(await fs.readdir(tempRoot)).toEqual(["llama-server"]);
});

it.each(["missing", "wrong-size", "wrong-sha256", "wrong-header"] as const)(
  "rejects a %s curated projector before changing the working preset or downloading",
  async (outcome) => {
    useSmallMediaArtifacts(outcome === "wrong-header" ? "HTML" : "GGUF");
    await fs.writeFile(presetPath, activeChat);
    await fs.writeFile(path.join(tempRoot, recipe.model.fileName), "GGUF");
    if (outcome !== "missing") {
      await fs.writeFile(
        path.join(tempRoot, recipe.projector.fileName),
        { "wrong-size": "GGUFpartial", "wrong-sha256": "GGUx", "wrong-header": "HTML" }[outcome],
      );
    }
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(ensureManagedLlamaServerForChat(mediaRequest())).rejects.toThrow(
      outcome === "wrong-header" ? "not a GGUF file" : /Model is not cached.*--method local-media/u,
    );
    expect(await fs.readFile(presetPath, "utf8")).toBe(activeChat);
    expect(fetch).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  },
);

it("passes media inference cancellation through model preparation before touching the preset", async () => {
  useSmallMediaArtifacts();
  await fs.writeFile(presetPath, activeChat);
  const controller = new AbortController();
  controller.abort(new Error("image request cancelled"));
  await expect(
    ensureManagedLlamaServerForChat({ ...mediaRequest(), signal: controller.signal }),
  ).rejects.toBe(controller.signal.reason);
  expect(await fs.readFile(presetPath, "utf8")).toBe(activeChat);
  expect(install).not.toHaveBeenCalled();
});

it("refreshes a cached media model while preserving chat without inventing embeddings", async () => {
  useSmallMediaArtifacts();
  const chat = "[custom-chat]\n; operator model\nmodel = /models/chat.gguf\nctx-size = 8192";
  await fs.writeFile(presetPath, `version = 1\n\n${chat}\n[stale]\nmodel = /models/stale.gguf\n`);
  for (const artifact of [recipe.model, recipe.projector]) {
    await fs.writeFile(path.join(tempRoot, artifact.fileName), "GGUF");
  }
  const fetch = vi.spyOn(globalThis, "fetch");
  provider.models = [
    buildLlamaCppModel({ id: "custom-chat", name: "Chat", source: "/models/chat.gguf" }),
  ];
  localService.args.push("--models-max", "1");
  await ensureManagedLlamaServerForChat(mediaRequest({ imageMaxTokens: 512, device: "CUDA1" }));
  const preset = await fs.readFile(presetPath, "utf8");
  expect(preset).toContain(chat);
  expect(preset).not.toContain("[stale]");
  expect(preset).toContain(`mmproj = ${path.join(tempRoot, recipe.projector.fileName)}`);
  expect(preset).toContain("image-max-tokens = 512");
  expect(preset).toContain("mmproj-device = CUDA1");
  expect(preset).toContain("split-mode = none");
  expect(preset).not.toContain("embedding");
  expect(fetch).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
});
