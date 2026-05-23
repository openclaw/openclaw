import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "./loader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("loadExtensions", () => {
  it("resolves public LLM plugin SDK subpaths in jiti-loaded extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-sdk-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.ts");
    await writeFile(
      extensionPath,
      `
import * as llmAnthropic from "openclaw/plugin-sdk/llm-anthropic";
import * as llmBedrock from "openclaw/plugin-sdk/llm-bedrock";
import * as llmGoogleShared from "openclaw/plugin-sdk/llm-google-shared";
import * as llmOpenAiCodexResponses from "openclaw/plugin-sdk/llm-openai-codex-responses";
import * as llmOpenAiCompletions from "openclaw/plugin-sdk/llm-openai-completions";
import * as llmOpenAiResponses from "openclaw/plugin-sdk/llm-openai-responses";
import * as llmProviderRuntime from "openclaw/plugin-sdk/llm-provider-runtime";

export default async function(api) {
  if (!llmBedrock.supportsBedrockPromptCaching("anthropic.claude-3-7-sonnet")) {
    throw new Error("bedrock helper unavailable");
  }
  void llmAnthropic;
  void llmGoogleShared;
  void llmOpenAiCodexResponses;
  void llmOpenAiCompletions;
  void llmOpenAiResponses;
  void llmProviderRuntime;
  api.registerCommand("sdk-subpath-probe", {
    description: "probe",
    handler() {},
  });
}
`,
    );

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.commands.has("sdk-subpath-probe")).toBe(true);
  });
});
