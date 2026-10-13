import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { withMockedPlatform } from "openclaw/plugin-sdk/test-node-mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLlamaServerPreset, type LlamaServerPresetOptions } from "./llama-server-preset.js";
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
  it.each(["embeddinggemma-300m-qat-Q8_0.gguf", "custom.gguf"])(
    "bounds fresh and regenerated presets for %s without relying on model identity",
    (filename) => {
      const options = { embeddingModelPath: `/models/${filename}` };
      const preset = refreshEmbedding(undefined, options);
      expect(preset).toBe(
        `version = 1\n\n${EMBEDDING}\nmodel = /models/${filename}\nembedding = true\n${CAPACITY}`,
      );
      expect(refreshEmbedding(preset, options)).toBe(preset);
    },
  );

  it("adds missing capacity bounds to an old section while preserving tuning", () => {
    const existing = `version = 1\n\n${EMBEDDING}\nmodel = /models/old.gguf\nubatch-size = 2048\nembedding = true\nflash-attn = on\n`;
    expect(refreshEmbedding(existing)).toBe(
      `version = 1\n\n${EMBEDDING}\nmodel = /models/embedding.gguf\nubatch-size = 2048\nembedding = true\nflash-attn = on\nparallel = 1\nctx-size = 2048\n`,
    );
  });

  it.each([
    { label: "parallel key", global: "", section: "parallel = 4\n" },
    { label: "np alias", global: "", section: "np = 2\n" },
    { label: "environment alias", global: "", section: "LLAMA_ARG_N_PARALLEL = 3\n" },
    { label: "[*] default", global: "[*]\nparallel = 2\n\n", section: "" },
  ])("keeps a preset $label slot count without shrinking its context", ({ global, section }) => {
    const existing = `version = 1\n\n${global}${EMBEDDING}\nmodel = /models/old.gguf\n${section}embedding = true\n`;
    const preset = refreshEmbedding(existing);
    expect(preset).not.toContain("parallel = 1");
    expect(preset).not.toContain("ctx-size");
    expect(preset).toContain(`${global}${EMBEDDING}\nmodel = /models/embedding.gguf\n${section}`);
    expect(preset).toContain("ubatch-size = 2048");
  });

  it.each([
    { global: "", section: "c = 4096\nub = 4096\n" },
    { global: "[*]\nLLAMA_ARG_CTX_SIZE = 8192\nLLAMA_ARG_UBATCH = 1024\n\n", section: "" },
    { global: "", section: "kv-unified-per-slot = 8192\nub = 4096\n" },
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

  it.each([
    { label: "env", serviceSettings: { env: { LLAMA_ARG_N_PARALLEL: "4" } } },
    { label: "--parallel arg", serviceSettings: { args: ["--port", "1", "--parallel", "2"] } },
    { label: "-np arg", serviceSettings: { args: ["-np", "3"] } },
  ])("keeps the router service's $label slot/context policy", ({ serviceSettings }) => {
    const preset = refreshEmbedding(undefined, { serviceSettings });
    expect(preset).not.toMatch(/parallel|ctx-size/u);
    expect(preset).toContain("ubatch-size = 2048");
  });

  it.each(["--kv-unified-per-slot", "--kv_unified_per_slot"])(
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

  it.each([
    { platform: "win32", key: "llama_arg_n_parallel", expectedDefault: false },
    { platform: "win32", key: "Llama_Arg_N_Parallel", expectedDefault: false },
    { platform: "linux", key: "llama_arg_n_parallel", expectedDefault: true },
    { platform: "linux", key: "parallel", expectedDefault: true },
  ] as const)(
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
