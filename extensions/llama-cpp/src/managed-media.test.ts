import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const installMocks = vi.hoisted(() => ({
  ensureLlamaServerInstalled: vi.fn(),
  resolveManagedLlamaServerPaths: vi.fn(),
}));

vi.mock("./llama-server-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llama-server-install.js")>()),
  ensureLlamaServerInstalled: installMocks.ensureLlamaServerInstalled,
  resolveManagedLlamaServerPaths: installMocks.resolveManagedLlamaServerPaths,
}));

import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { selectLlamaServerAsset } from "./llama-server-install.js";
import {
  ensureLlamaCppModel,
  ensureManagedLlamaServerForChat,
  prepareManagedLlamaServer,
  resolveLlamaCppPresetPath,
} from "./managed-server.js";
import * as mediaCatalog from "./media-catalog.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function createPresetFixture(label: string) {
  const tempRoot = tempDirs.make(`llama-server-${label}-`);
  const presetPath = path.join(tempRoot, "models.ini");
  const asset = selectLlamaServerAsset("darwin", "arm64");
  installMocks.ensureLlamaServerInstalled.mockResolvedValue({
    command: path.join(tempRoot, "llama-server"),
    asset,
  });
  installMocks.resolveManagedLlamaServerPaths.mockReturnValue({
    installDir: tempRoot,
    command: path.join(tempRoot, "llama-server"),
    presetPath,
  });
  return { tempRoot, presetPath };
}

function useSmallMediaArtifacts(payload = "GGUF") {
  const recipe = mediaCatalog.LLAMA_CPP_MEDIA_RECIPES.find(
    (candidate) => candidate.capability === "ocr",
  )!;
  const resolveArtifact = mediaCatalog.resolveLlamaCppMediaArtifact;
  // Keep real curated identities and replace only bytes/digests at the artifact boundary.
  vi.spyOn(mediaCatalog, "resolveLlamaCppMediaArtifact").mockImplementation((source) => {
    const artifact = resolveArtifact(source);
    return artifact
      ? {
          ...artifact,
          expectedSize: Buffer.byteLength(payload),
          expectedSha256: createHash("sha256").update(payload).digest("hex"),
        }
      : undefined;
  });
  return recipe;
}

describe("managed llama.cpp media artifacts and presets", () => {
  it.each(["none", "CUDA1"])(
    "isolates media verification and pins both model and projector to %s",
    async (device) => {
      const { tempRoot, presetPath } = await createPresetFixture("media-candidate");
      const header = "version = 1\r\n; operator defaults\r\n[*]\r\nthreads = 6\r\n\r\n";
      const chat =
        "[chat]\r\n; chat stays available\r\nmodel = /models/chat.gguf\r\nn-gpu-layers = 7";
      const custom = "[custom]\r\nmodel = /models/custom.gguf\r\nctx-size = 8192";
      const embedding =
        "[embeddinggemma-300m-qat-q8_0]\r\nmodel = /models/embedding.gguf\r\nembedding = true\r\npooling = mean";
      const oldMedia = [
        "[ocr]",
        "mm = /models/old-projector.gguf ; projector comment",
        "LLAMA_ARG_IMAGE_MAX_TOKENS = 4096",
        "np = 8",
        "dev = CUDA0,CUDA1",
        "mmdev = CUDA0",
        "sm = layer",
        "load-on-startup = true",
      ].join("\r\n");
      const active = header + [chat, custom, oldMedia, embedding].join("\r\n\r\n") + "\r\n";
      await fs.writeFile(presetPath, active);
      const asset = selectLlamaServerAsset("linux", "x64");
      const controller = new AbortController();
      const localService = {
        command: path.join(tempRoot, "old-server"),
        args: [
          "--host=0.0.0.0",
          "--port",
          "19431",
          `--models-preset=${presetPath}`,
          "--models-max",
          "2",
          "--threads",
          "6",
          "--metrics",
        ],
        healthUrl: "http://127.0.0.1:19431/health",
      };
      const candidate = await prepareManagedLlamaServer({
        chatModel: { mode: "preserve" },
        mediaModels: ["ocr", "vision"].map((id) => ({
          id,
          path: `/models/${id}.gguf`,
          projectorPath: `/models/${id}-projector.gguf`,
          contextSize: 4096,
          maxTokens: 512,
          imageMaxTokens: 1024,
          device,
        })),
        asset,
        localService,
        isolated: true,
        modelsMax: 1,
        port: 19435,
        signal: controller.signal,
      });

      expect(candidate.command).toBe(path.join(tempRoot, "llama-server"));
      expect(installMocks.ensureLlamaServerInstalled).toHaveBeenCalledWith(
        expect.objectContaining({ asset, signal: controller.signal }),
      );
      expect(candidate.baseUrl).toBe("http://127.0.0.1:19435/v1");
      expect(candidate.healthUrl).toBe("http://127.0.0.1:19435/health");
      const candidatePreset = resolveLlamaCppPresetPath({
        command: candidate.command,
        args: candidate.args,
      })!;
      expect(candidatePreset).not.toBe(presetPath);
      expect(candidate.args).toEqual([
        "--threads",
        "6",
        "--metrics",
        "--host",
        "127.0.0.1",
        "--port",
        "19435",
        "--models-preset",
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
      for (const id of ["ocr", "vision"]) {
        expect(prepared).toContain(`mmproj = /models/${id}-projector.gguf`);
      }
      expect(prepared).toContain("mmproj = /models/ocr-projector.gguf ; projector comment");
      expect(prepared.match(new RegExp(`^device = ${device}$`, "gm"))).toHaveLength(2);
      expect(prepared.match(new RegExp(`^mmproj-device = ${device}$`, "gm"))).toHaveLength(2);
      expect(prepared.match(/^split-mode = none$/gm)).toHaveLength(2);
      expect(prepared.match(/^load-on-startup = false$/gm)).toHaveLength(2);
      expect(prepared.match(/^parallel = 1$/gm)).toHaveLength(2);
      expect(prepared).not.toMatch(/^(?:mm|dev|mmdev|sm|np|LLAMA_ARG_IMAGE_MAX_TOKENS) =/m);
    },
  );

  it("prepares media-only presets without inventing an embedding model", async () => {
    await createPresetFixture("media-only");
    const candidate = await prepareManagedLlamaServer({
      chatModel: { mode: "preserve" },
      mediaModels: [
        { id: "vision", path: "/models/vision.gguf", projectorPath: "/models/mmproj.gguf" },
      ],
      isolated: true,
      modelsMax: 1,
      port: 19437,
    });
    const preset = resolveLlamaCppPresetPath({ command: candidate.command, args: candidate.args })!;
    expect(await fs.readFile(preset, "utf8")).toContain("[vision]");
    expect(await fs.readFile(preset, "utf8")).not.toContain("embedding");
    expect(
      candidate.args.slice(
        candidate.args.indexOf("--models-max"),
        candidate.args.indexOf("--models-max") + 2,
      ),
    ).toEqual(["--models-max", "1"]);
  });

  it("stops cancelled media preparation before publishing a preset", async () => {
    const { tempRoot } = await createPresetFixture("media-cancelled");
    const controller = new AbortController();
    installMocks.ensureLlamaServerInstalled.mockImplementationOnce(() => {
      controller.abort(new Error("setup cancelled"));
      return { command: path.join(tempRoot, "llama-server") };
    });
    await expect(
      prepareManagedLlamaServer({
        chatModel: { mode: "preserve" },
        mediaModels: [
          { id: "vision", path: "/models/vision.gguf", projectorPath: "/models/mmproj.gguf" },
        ],
        isolated: true,
        modelsMax: 1,
        signal: controller.signal,
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });

  it("reuses verified curated model and projector bytes without metadata or download requests", async () => {
    const recipe = useSmallMediaArtifacts();
    const cacheDir = tempDirs.make("llama-media-verified-");
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const artifact of [recipe.model, recipe.projector]) {
      const destination = path.join(cacheDir, artifact.fileName);
      await fs.writeFile(destination, "GGUF");
      for (const download of [false, true]) {
        await expect(
          ensureLlamaCppModel({ source: artifact.source, cacheDir, download }),
        ).resolves.toBe(destination);
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["missing", "wrong-size", "wrong-sha256"])(
    "rejects a %s curated projector before changing the working preset or downloading",
    async (outcome) => {
      const recipe = useSmallMediaArtifacts();
      const { tempRoot, presetPath } = await createPresetFixture("media-invalid-projector");
      const active = "version = 1\n\n[chat]\nmodel = /models/chat.gguf\n";
      await fs.writeFile(presetPath, active);
      await fs.writeFile(path.join(tempRoot, recipe.model.fileName), "GGUF");
      if (outcome !== "missing") {
        await fs.writeFile(
          path.join(tempRoot, recipe.projector.fileName),
          outcome === "wrong-size" ? "GGUFpartial" : "GGUx",
        );
      }
      const fetch = vi.spyOn(globalThis, "fetch");
      await expect(
        ensureManagedLlamaServerForChat({
          provider: {
            baseUrl: "http://127.0.0.1:19432/v1",
            localService: {
              command: path.join(tempRoot, "llama-server"),
              args: ["--models-preset", presetPath],
            },
            models: [],
            params: { modelCacheDir: tempRoot, mediaModels: { ocr: recipe.id, vision: "vision" } },
          },
          model: {
            id: recipe.id,
            params: { modelPath: recipe.model.source, mmprojPath: recipe.projector.source },
          },
        }),
      ).rejects.toThrow(/Model is not cached.*--method local-media/u);
      expect(await fs.readFile(presetPath, "utf8")).toBe(active);
      expect(fetch).not.toHaveBeenCalled();
      expect(installMocks.ensureLlamaServerInstalled).not.toHaveBeenCalled();
    },
  );

  it("rejects a cached curated projector with a matching digest but a non-GGUF header", async () => {
    const recipe = useSmallMediaArtifacts("HTML");
    const cacheDir = tempDirs.make("llama-media-projector-format-");
    const projector = path.join(cacheDir, recipe.projector.fileName);
    await fs.writeFile(projector, "HTML");
    await expect(
      ensureLlamaCppModel({ source: recipe.projector.source, cacheDir, download: false }),
    ).rejects.toThrow("not a GGUF file");
  });

  it("passes media inference cancellation through model preparation before touching the preset", async () => {
    const recipe = useSmallMediaArtifacts();
    const { tempRoot, presetPath } = await createPresetFixture("media-abort-inference");
    const active = "version = 1\n\n[chat]\nmodel = /models/chat.gguf\n";
    await fs.writeFile(presetPath, active);
    const controller = new AbortController();
    controller.abort(new Error("image request cancelled"));
    await expect(
      ensureManagedLlamaServerForChat({
        provider: {
          baseUrl: "http://127.0.0.1:19432/v1",
          localService: {
            command: path.join(tempRoot, "llama-server"),
            args: ["--models-preset", presetPath],
          },
          models: [],
          params: { modelCacheDir: tempRoot, mediaModels: { ocr: recipe.id, vision: "vision" } },
        },
        model: {
          id: recipe.id,
          params: { modelPath: recipe.model.source, mmprojPath: recipe.projector.source },
        },
        signal: controller.signal,
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(await fs.readFile(presetPath, "utf8")).toBe(active);
    expect(installMocks.ensureLlamaServerInstalled).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "refreshes a cached media model while preserving chat and embedding presence (%s)",
    async (hasEmbedding) => {
      const recipe = useSmallMediaArtifacts();
      const { tempRoot, presetPath } = await createPresetFixture("media-refresh");
      const chat = "[custom-chat]\n; operator model\nmodel = /models/chat.gguf\nctx-size = 8192";
      const embedding =
        "[embeddinggemma-300m-qat-q8_0]\nmodel = /models/custom-embedding.gguf\nembedding = true\npooling = mean";
      await fs.writeFile(
        presetPath,
        `version = 1\n\n${chat}\n${hasEmbedding ? `\n${embedding}\n` : ""}`,
      );
      for (const artifact of [recipe.model, recipe.projector]) {
        await fs.writeFile(path.join(tempRoot, artifact.fileName), "GGUF");
      }
      const fetch = vi.spyOn(globalThis, "fetch");
      await ensureManagedLlamaServerForChat({
        provider: {
          baseUrl: "http://127.0.0.1:19432/v1",
          localService: {
            command: path.join(tempRoot, "llama-server"),
            args: ["--models-preset", presetPath, "--models-max", "1"],
          },
          models: [],
          params: { modelCacheDir: tempRoot, mediaModels: { ocr: recipe.id, vision: "vision" } },
        },
        model: {
          id: recipe.id,
          params: {
            modelPath: recipe.model.source,
            mmprojPath: recipe.projector.source,
            imageMaxTokens: 512,
            device: "CUDA1",
          },
        },
      });
      const preset = await fs.readFile(presetPath, "utf8");
      expect(preset).toContain(chat);
      expect(preset).toContain(`mmproj = ${path.join(tempRoot, recipe.projector.fileName)}`);
      expect(preset).toContain("image-max-tokens = 512");
      expect(preset).toContain("mmproj-device = CUDA1");
      expect(preset).toContain("split-mode = none");
      if (hasEmbedding) {
        expect(preset).toContain(embedding);
      } else {
        expect(preset).not.toContain("embedding");
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(installMocks.ensureLlamaServerInstalled).not.toHaveBeenCalled();
    },
  );
});
