import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLlamaServerPreset, type LlamaServerPresetOptions } from "./llama-server-preset.js";
import { prepareManagedLlamaServer } from "./managed-server.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
});
const EMBEDDING = "[embeddinggemma-300m-qat-q8_0]";

function refreshDefaultEmbedding(
  existing: string | undefined,
  options: Partial<LlamaServerPresetOptions> = {},
): string {
  return buildLlamaServerPreset(existing, {
    chatModel: { mode: "remove" },
    embeddingModelIsDefault: true,
    embeddingModelPath: "/models/embedding.gguf",
    ...options,
  });
}

describe("managed embedding slot default", () => {
  it("writes one slot for a new default embedding preset", () => {
    expect(refreshDefaultEmbedding(undefined)).toBe(
      `version = 1\n\n${EMBEDDING}\nmodel = /models/embedding.gguf\nubatch-size = 2048\nembedding = true\nparallel = 1\n`,
    );
  });

  it("adds the slot bound when regenerating an existing default embedding section", () => {
    const existing = `version = 1\n\n${EMBEDDING}\nmodel = /models/old.gguf\nubatch-size = 2048\nembedding = true\nflash-attn = on\n`;
    expect(refreshDefaultEmbedding(existing)).toBe(
      `version = 1\n\n${EMBEDDING}\nmodel = /models/embedding.gguf\nubatch-size = 2048\nembedding = true\nflash-attn = on\nparallel = 1\n`,
    );
  });

  it("leaves llama.cpp slot defaults for a custom embedding model", () => {
    expect(refreshDefaultEmbedding(undefined, { embeddingModelIsDefault: false })).not.toContain(
      "parallel",
    );
  });

  it.each([
    { label: "parallel key", global: "", section: "parallel = 4\n" },
    { label: "np alias", global: "", section: "np = 2\n" },
    { label: "environment alias", global: "", section: "LLAMA_ARG_N_PARALLEL = 3\n" },
    { label: "[*] default", global: "[*]\nparallel = 2\n\n", section: "" },
  ])("keeps a preset $label slot count", ({ global, section }) => {
    const existing = `version = 1\n\n${global}${EMBEDDING}\nmodel = /models/old.gguf\n${section}embedding = true\n`;
    const preset = refreshDefaultEmbedding(existing);
    expect(preset).not.toContain("parallel = 1");
    expect(preset).toContain(`${global}${EMBEDDING}\nmodel = /models/embedding.gguf\n${section}`);
  });

  it.each([
    { label: "env", serviceSettings: { env: { LLAMA_ARG_N_PARALLEL: "4" } } },
    { label: "--parallel arg", serviceSettings: { args: ["--port", "1", "--parallel", "2"] } },
    { label: "-np arg", serviceSettings: { args: ["-np", "3"] } },
    { label: "--parallel= arg", serviceSettings: { args: ["--parallel=2"] } },
    {
      label: "lowercase Windows env",
      serviceSettings: { env: { llama_arg_n_parallel: "4" }, platform: "win32" as const },
    },
    {
      label: "mixed-case Windows env",
      serviceSettings: { env: { Llama_Arg_N_Parallel: "4" }, platform: "win32" as const },
    },
  ])("keeps a slot count the router service sets through its $label", ({ serviceSettings }) => {
    expect(refreshDefaultEmbedding(undefined, { serviceSettings })).not.toContain("parallel");
  });

  it("bounds slots when a POSIX env name differs only in case", () => {
    expect(
      refreshDefaultEmbedding(undefined, {
        serviceSettings: { env: { llama_arg_n_parallel: "4" }, platform: "linux" },
      }),
    ).toContain("embedding = true\nparallel = 1\n");
  });
});

describe("managed embedding slot default through server preparation", () => {
  it("keeps the configured service's environment slot count on regeneration", async () => {
    const root = tempDirs.make("llama-server-service-slots-");
    const presetPath = path.join(root, "custom.ini");
    await fs.writeFile(presetPath, `version = 1\n\n${EMBEDDING}\nmodel = /models/old.gguf\n`);
    await prepareManagedLlamaServer({
      localService: {
        command: path.join(root, "custom-server"),
        args: ["--models-preset", presetPath],
        env: { LLAMA_ARG_N_PARALLEL: "4" },
      },
      chatModel: { mode: "remove" },
      embeddingModelIsDefault: true,
      embeddingModelPath: "/models/embedding.gguf",
      port: 19_436,
    });
    expect(await fs.readFile(presetPath, "utf8")).toBe(
      `version = 1\n\n${EMBEDDING}\nmodel = /models/embedding.gguf\nubatch-size = 2048\nembedding = true\n`,
    );
  });

  async function prepareCandidatePreset(root: string, activePreset: string): Promise<string> {
    const runtime = await prepareManagedLlamaServer({
      localService: {
        command: path.join(root, "custom-server"),
        args: ["--models-preset", activePreset, "--parallel", "4"],
        env: { LLAMA_ARG_N_PARALLEL: "4" },
      },
      isolated: true,
      chatModel: { mode: "remove" },
      embeddingModelIsDefault: true,
      embeddingModelPath: "/models/embedding.gguf",
      port: 19_437,
    });
    const candidatePreset = String(runtime.args[runtime.args.indexOf("--models-preset") + 1]);
    expect(candidatePreset).not.toBe(activePreset);
    return await fs.readFile(candidatePreset, "utf8");
  }

  it("bounds an isolated candidate, which is accepted without the service args and env", async () => {
    const root = tempDirs.make("llama-server-candidate-slots-");
    const activePreset = path.join(root, "models.ini");
    await fs.writeFile(activePreset, "version = 1\n");
    expect(await prepareCandidatePreset(root, activePreset)).toContain(
      "embedding = true\nparallel = 1\n",
    );
    expect(await fs.readFile(activePreset, "utf8")).toBe("version = 1\n");
  });

  it("keeps a slot count inherited from the OpenClaw process environment", async () => {
    vi.stubEnv("LLAMA_ARG_N_PARALLEL", "4");
    const root = tempDirs.make("llama-server-process-env-slots-");
    const presetPath = path.join(root, "custom.ini");
    await fs.writeFile(presetPath, `version = 1\n\n${EMBEDDING}\nmodel = /models/old.gguf\n`);
    await prepareManagedLlamaServer({
      localService: {
        command: path.join(root, "custom-server"),
        args: ["--models-preset", presetPath],
      },
      chatModel: { mode: "remove" },
      embeddingModelIsDefault: true,
      embeddingModelPath: "/models/embedding.gguf",
      port: 19_436,
    });
    expect(await fs.readFile(presetPath, "utf8")).not.toContain("parallel");
    expect(await prepareCandidatePreset(root, presetPath)).not.toContain("parallel");
  });
});
