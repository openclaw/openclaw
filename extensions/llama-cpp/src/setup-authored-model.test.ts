import os from "node:os";
import path from "node:path";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import {
  buildLlamaCppModel,
  DEFAULT_LLAMA_CPP_MODEL_URI,
  LLAMA_CPP_PROVIDER_ID,
} from "./defaults.js";
import { authContext, GIB, mocks, modelPath, tempRoot } from "./setup.test-support.js";

const { runLlamaCppSetup } = await import("./setup.js");

function authoredChatContext(source: string, confirm = true): ProviderAuthContext {
  const ctx = authContext(confirm);
  const model = buildLlamaCppModel({ id: "selected", name: "Selected GGUF", source });
  ctx.config.models = {
    providers: {
      [LLAMA_CPP_PROVIDER_ID]: {
        baseUrl: "http://127.0.0.1:19432/v1",
        params: { modelCacheDir: tempRoot },
        localService: { command: path.join(tempRoot, "llama-server") },
        models: [buildLlamaCppModel({ id: "other", name: "Other GGUF", source: modelPath }), model],
      },
    },
  };
  ctx.config.agents = { defaults: { model: { primary: "llama-cpp/selected" } } };
  return ctx;
}

describe("llama.cpp authored model setup", () => {
  it.each([
    {
      source:
        "hf:unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf#e87f176479d0855a907a41277aca2f8ee7a09523",
      size: "2.7 GB",
    },
    { source: "hf:owner/repo/custom.gguf", size: "1.2 GB" },
    { source: "https://models.example/custom.gguf", size: "1.2 GB" },
    { source: "https://models.example/no-head.gguf", size: "size unknown", headStatus: 405 },
    { source: "https://models.example/broken-head.gguf", size: "size unknown", headError: true },
  ])(
    "offers the selected uncached $source instead of the hardware recommendation",
    async ({ source, size, headStatus, headError }) => {
      vi.mocked(os.totalmem).mockReturnValue(512 * GIB);
      const ctx = authoredChatContext(source);
      mocks.downloadFetch.mockImplementation(async () => {
        if (headError) {
          throw new Error("HEAD connection closed");
        }
        return {
          response: source.startsWith("https:")
            ? new Response(null, {
                status: headStatus,
                headers: { "content-length": "1200000000" },
              })
            : Response.json([
                { path: "custom.gguf", size: 1_200_000_000, lfs: { oid: "a".repeat(64) } },
              ]),
          release: vi.fn(),
        };
      });
      const selected = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID]?.models[1];

      const result = await runLlamaCppSetup(ctx);

      expect(ctx.prompter.confirm).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: expect.stringContaining(`Download Selected GGUF (${size})`),
          initialValue: false,
        }),
      );
      expect(result.defaultModel).toBe("llama-cpp/selected");
      expect(result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID]?.models[0]).toEqual(
        selected,
      );
      expect(mocks.ensureModel).toHaveBeenCalledWith(
        expect.objectContaining({ source, download: true }),
      );
      expect(mocks.prepareServer).toHaveBeenCalledWith(
        expect.objectContaining({ chatModel: expect.objectContaining({ id: "selected" }) }),
      );
    },
  );

  it("leaves an authored route unchanged when its download is declined", async () => {
    const ctx = authoredChatContext(DEFAULT_LLAMA_CPP_MODEL_URI, false);
    ctx.config.memory = { search: { provider: "local" } };
    const before = structuredClone(ctx.config);

    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });

    expect(ctx.prompter.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining("Download Selected GGUF") }),
    );
    expect(ctx.config).toEqual(before);
    expect(mocks.ensureServerInstalled).not.toHaveBeenCalled();
    expect(mocks.ensureModel).not.toHaveBeenCalledWith(expect.objectContaining({ download: true }));
    expect(mocks.prepareServer).not.toHaveBeenCalled();
  });

  it.each([
    ["hf:invalid", "Invalid Hugging Face model URI"],
    ["https://models.example/model.txt", "Remote model URL must name a GGUF file"],
    ["ftp://models.example/model.gguf", "Unsupported remote model URI"],
  ])("explains why the authored source %s cannot be used", async (source, reason) => {
    const ctx = authoredChatContext(source);

    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });

    expect(ctx.prompter.note).toHaveBeenCalledWith(
      expect.stringContaining(reason),
      "Setup skipped",
    );
    expect(ctx.prompter.confirm).not.toHaveBeenCalled();
    expect(mocks.ensureServerInstalled).not.toHaveBeenCalled();
  });
});
