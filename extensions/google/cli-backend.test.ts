// Google CLI backend tests cover bundled CLI runtime descriptors.
import { describe, expect, it } from "vitest";
import { applyPluginTextReplacements } from "../../src/agents/plugin-text-transforms.js";
import { buildGoogleAntigravityCliBackend, buildGoogleGeminiCliBackend } from "./cli-backend.js";

/** Sentences agy emits as pre-tool narration that should be filtered out. */
const ANTIGRAVITY_NARRATION_POSITIVES = [
  "I will list the contents of the project workspace.",
  "I will read the memory files at ~/.openclaw.",
  "I will search the web for No Game No Life and Disboard.",
  "I will check the updated config file.",
  "I will view the remaining lines of the log.",
  "I will edit the file extensions/google/cli-backend.ts.",
  "I will search the repository for mentions of agy.",
];

/** Legitimate assistant sentences that start with "I will" and MUST stay. */
const ANTIGRAVITY_NARRATION_NEGATIVES = [
  "I will see how to start a goal or update the plan.",
  "I will maintain a conversational tone by using natural language.",
  "I will add the following files to the list.",
  "I will return tomorrow with results.",
];

describe("google cli backends", () => {
  it("keeps the Gemini CLI backend configured for JSON sessions", () => {
    const backend = buildGoogleGeminiCliBackend();

    expect(backend.id).toBe("google-gemini-cli");
    expect(backend.modelProvider).toBe("google");
    expect(backend.config.command).toBe("gemini");
    expect(backend.config.output).toBe("json");
    expect(backend.config.sessionMode).toBe("existing");
  });

  it("builds the Antigravity CLI backend around agy text output", () => {
    const backend = buildGoogleAntigravityCliBackend();

    expect(backend.id).toBe("google-antigravity-cli");
    expect(backend.modelProvider).toBe("google");
    expect(backend.nativeToolMode).toBe("always-on");
    expect(backend.liveTest).toMatchObject({
      defaultModelRef: "google-antigravity-cli/gemini-3.5-flash",
      defaultImageProbe: false,
      defaultMcpProbe: false,
      docker: { binaryName: "agy" },
    });
    expect(backend.config).toMatchObject({
      command: "agy",
      args: ["--print", "{prompt}"],
      output: "text",
      input: "arg",
      modelArg: "--model",
      modelAliases: {
        flash: "gemini-3.5-flash",
        pro: "gemini-3.1-pro-preview",
      },
      sessionMode: "none",
      serialize: true,
    });
    expect(backend.config).not.toHaveProperty("parseToolCalls");
    expect(backend.config).not.toHaveProperty("imageArg");
    expect(backend.config).not.toHaveProperty("imagePathScope");
  });

  it("filters agy pre-tool narration without trapping legitimate I-will sentences", () => {
    const backend = buildGoogleAntigravityCliBackend();
    const output = backend.textTransforms?.output;
    expect(output).toBeDefined();

    for (const positive of ANTIGRAVITY_NARRATION_POSITIVES) {
      const result = applyPluginTextReplacements(positive, output);
      expect(result.trim()).toBe("");
    }
    for (const negative of ANTIGRAVITY_NARRATION_NEGATIVES) {
      const result = applyPluginTextReplacements(negative, output);
      expect(result).toBe(negative);
    }
  });
});
