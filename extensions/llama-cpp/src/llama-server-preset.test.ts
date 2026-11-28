import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { withMockedPlatform } from "openclaw/plugin-sdk/test-node-mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertMediaPresetLimits,
  buildLlamaServerPreset,
  type LlamaServerPresetOptions,
} from "./llama-server-preset.js";
import { prepareManagedLlamaServer } from "./managed-server.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
});
const EMBEDDING = "[embeddinggemma-300m-qat-q8_0]";
const CAPACITY = "parallel = 1\nctx-size = 2048\nubatch-size = 2048\n";

function refreshEmbedding(
  existing: string | undefined,
  options: Partial<LlamaServerPresetOptions> = {},
): string {
  return buildLlamaServerPreset(existing, {
    chatModel: { mode: "remove" },
    embeddingModelPath: "/models/embedding.gguf",
    ...options,
  });
}

describe("managed embedding capacity defaults", () => {
  it.each([{ label: "np alias", global: "", section: "np = 2\n" }])(
    "keeps a preset $label slot count without shrinking its context",
    ({ global, section }) => {
      const existing = `version = 1\n\n${global}${EMBEDDING}\nmodel = /models/old.gguf\n${section}embedding = true\n`;
      const preset = refreshEmbedding(existing);
      expect(preset).not.toContain("parallel = 1");
      expect(preset).not.toContain("ctx-size");
      expect(preset).toContain(`${global}${EMBEDDING}\nmodel = /models/embedding.gguf\n${section}`);
      expect(preset).toContain("ubatch-size = 2048");
    },
  );

  it.each([
    {
      global: "[*]\nLLAMA_ARG_KV_UNIFIED_PER_SLOT = 8192\nLLAMA_ARG_UBATCH = 1024\n\n",
      section: "",
    },
  ])("keeps explicit context and physical batch settings", ({ global, section }) => {
    const existing = `version = 1\n\n${global}${EMBEDDING}\nmodel = /models/old.gguf\n${section}`;
    const preset = refreshEmbedding(existing);
    expect(preset).toContain(`${global}${EMBEDDING}\nmodel = /models/embedding.gguf\n${section}`);
    expect(preset).toContain("parallel = 1");
    expect(preset).not.toMatch(/ctx-size|ubatch-size/u);
  });

  it.each([{ label: "-np arg", serviceSettings: { args: ["-np", "3"] } }])(
    "keeps the router service's $label slot/context policy",
    ({ serviceSettings }) => {
      const preset = refreshEmbedding(undefined, { serviceSettings });
      expect(preset).not.toMatch(/parallel|ctx-size/u);
      expect(preset).toContain("ubatch-size = 2048");
    },
  );

  it.each(["--kv_unified_per_slot"])(
    "preserves native per-slot sizing from the service's %s option",
    (option) => {
      const preset = refreshEmbedding(undefined, {
        serviceSettings: { args: [option, "8192"] },
      });
      expect(preset).not.toContain("ctx-size");
      expect(preset).toContain("parallel = 1");
      expect(preset).toContain("ubatch-size = 2048");
    },
  );

  it.each([{ platform: "win32", key: "Llama_Arg_N_Parallel", expectedDefault: false }] as const)(
    "matches $platform environment names for $key",
    ({ platform, key, expectedDefault }) => {
      withMockedPlatform(platform, () => {
        const preset = refreshEmbedding(undefined, { serviceSettings: { env: { [key]: "4" } } });
        expect(preset.includes("parallel = 1")).toBe(expectedDefault);
        expect(preset.includes("ctx-size = 2048")).toBe(expectedDefault);
      });
    },
  );
});

describe("managed embedding capacity through server preparation", () => {
  async function prepareCandidatePreset(root: string, activePreset: string): Promise<string> {
    const runtime = await prepareManagedLlamaServer({
      localService: {
        command: path.join(root, "custom-server"),
        args: ["--models-preset", activePreset, "--parallel", "4"],
        env: { LLAMA_ARG_N_PARALLEL: "4" },
      },
      isolated: true,
      chatModel: { mode: "remove" },
      embeddingModelPath: "/models/embedding.gguf",
      port: 19_437,
    });
    const candidatePreset = String(runtime.args[runtime.args.indexOf("--models-preset") + 1]);
    expect(candidatePreset).not.toBe(activePreset);
    return await fs.readFile(candidatePreset, "utf8");
  }

  it("bounds an isolated candidate without changing the active preset or adopting its settings", async () => {
    const root = tempDirs.make("llama-server-candidate-slots-");
    const activePreset = path.join(root, "models.ini");
    await fs.writeFile(activePreset, "version = 1\n");
    expect(await prepareCandidatePreset(root, activePreset)).toContain(CAPACITY);
    expect(await fs.readFile(activePreset, "utf8")).toBe("version = 1\n");
  });

  it.each(["service", "process"])("keeps slot settings from the %s environment", async (source) => {
    if (source === "process") {
      vi.stubEnv("LLAMA_ARG_N_PARALLEL", "4");
    }
    const root = tempDirs.make("llama-server-environment-slots-");
    const presetPath = path.join(root, "custom.ini");
    await fs.writeFile(presetPath, `version = 1\n\n${EMBEDDING}\nmodel = /models/old.gguf\n`);
    await prepareManagedLlamaServer({
      localService: {
        command: path.join(root, "custom-server"),
        args: ["--models-preset", presetPath],
        ...(source === "service" ? { env: { LLAMA_ARG_N_PARALLEL: "4" } } : {}),
      },
      chatModel: { mode: "remove" },
      embeddingModelPath: "/models/embedding.gguf",
      port: 19_436,
    });
    expect(await fs.readFile(presetPath, "utf8")).not.toMatch(/parallel|ctx-size/u);
    if (source === "process") {
      expect(await prepareCandidatePreset(root, presetPath)).not.toMatch(/parallel|ctx-size/u);
    }
  });
});

describe("managed media backend settings", () => {
  const mediaModel = {
    id: "vision",
    path: "/models/vision.gguf",
    projectorPath: "/models/projector.gguf",
    contextSize: 8192,
    imageMaxTokens: 1024,
  };

  it.each([
    ["ngl", "no-mmproj-offload"],
    ["n-gpu-layers", "mmproj-offload"],
    ["LLAMA_ARG_N_GPU_LAYERS", "LLAMA_ARG_MMPROJ_OFFLOAD"],
  ])(
    "overrides inherited CPU settings and the %s alias for Metal media",
    (gpuAlias, projectorAlias) => {
      const global =
        "[*]\ndevice = none\nmmproj-device = none\ngpu-layers = 0\nmmproj-offload = false\n\n";
      const preset = buildLlamaServerPreset(
        `version = 1\n\n${global}[vision]\ndev = none\nmmdev = none\n${gpuAlias} = 0\n${projectorAlias} = false\n`,
        {
          chatModel: { mode: "preserve" },
          mediaModels: [{ ...mediaModel, device: "MTL0" }],
        },
      );
      const section = preset.slice(preset.indexOf("[vision]"));
      expect(preset).toContain(global);
      expect(section).toContain("device = MTL0\nmmproj-device = MTL0\n");
      expect(section).toContain("gpu-layers = 999\nmmproj-offload = true\n");
      expect(section).not.toMatch(
        /^(?:dev|mmdev|ngl|n-gpu-layers|LLAMA_ARG_N_GPU_LAYERS|no-mmproj-offload)\s*=/mu,
      );
    },
  );

  it("keeps existing GPU layer and offload settings for CPU media", () => {
    const preset = buildLlamaServerPreset(
      "version = 1\n\n[vision]\nn-gpu-layers = 7\nmmproj-offload = false\n",
      {
        chatModel: { mode: "preserve" },
        mediaModels: [{ ...mediaModel, device: "none" }],
      },
    );
    expect(preset).toContain("n-gpu-layers = 7\nmmproj-offload = false\n");
    expect(preset).toContain("device = none\nmmproj-device = none\n");
    expect(preset).not.toContain("gpu-layers = 999");
  });

  it.each([
    ["--device", "none"],
    ["-dev", "none"],
    ["--dev=none"],
    ["--mmproj-device=none"],
    ["-mmdev", "none"],
    ["--gpu-layers", "0"],
    ["-ngl", "0"],
    ["--n-gpu-layers=0"],
    ["--no-mmproj-offload"],
    ["--mmproj-offload=false"],
  ])("rejects a router option that overrides Metal media: %j", (...args) => {
    expect(() => assertMediaPresetLimits(args, [mediaModel], "metal")).toThrow(
      "disables the selected Metal backend",
    );
    expect(() => assertMediaPresetLimits(args, [mediaModel], "cpu")).not.toThrow();
  });

  it("accepts compatible Metal options while retaining media limits", () => {
    const args = [
      "--device=MTL0",
      "--mmproj-device",
      "MTL0",
      "-ngl",
      "999",
      "--ctx-size=8192",
      "--image-max-tokens=1024",
      "-np",
      "1",
    ];
    expect(() => assertMediaPresetLimits(args, [mediaModel], "metal")).not.toThrow();
    expect(() =>
      assertMediaPresetLimits([...args, "--ctx-size=8193"], [mediaModel], "metal"),
    ).toThrow("exceeds the local media limit (8192)");
  });
});
