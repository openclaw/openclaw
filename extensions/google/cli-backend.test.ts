// Google CLI backend tests cover bundled CLI runtime descriptors.
import { describe, expect, it } from "vitest";
import { applyPluginTextReplacements } from "../../src/agents/plugin-text-transforms.js";
import { buildGoogleAntigravityCliBackend, buildGoogleGeminiCliBackend } from "./cli-backend.js";

/**
 * Pre-tool narration agy emits in English — must be filtered out wholesale.
 * Both "I will <verb> …" and "I am <verb-ing> …" forms, with or without
 * leading numbered prefix. The setup contract is that legitimate user-facing
 * Teto answers are in German, so any English first-person narration line is
 * by definition chatter.
 */
const ANTIGRAVITY_NARRATION_POSITIVES = [
  // "I will …" — narrow tool verbs
  "I will list the contents of the project workspace.",
  "I will read the memory files at ~/.openclaw.",
  "I will search the web for No Game No Life and Disboard.",
  "I will check the updated config file.",
  "I will view the remaining lines of the log.",
  "I will edit the file extensions/google/cli-backend.ts.",
  "I will search the repository for mentions of agy.",
  // "I will …" — broader phrasings (previously assumed legitimate, now also dropped)
  "I will see how to start a goal or update the plan.",
  "I will maintain a conversational tone by using natural language.",
  "I will add the following files to the list.",
  "I will return tomorrow with results.",
  "I will review the output as soon as it completes.",
  "I will report back immediately when the log retrieval completes.",
  // "I am <verb-ing> …" — background/long-running narration
  "I am running the openclaw status command in the background to inspect the overall state of the gateway, channels, and recent sessions.",
  "I am running a deep probe status check (openclaw status --deep) in the background to inspect all active services, database states, and connection parameters.",
  "I am fetching the latest 20 lines of Gateway logs to check for any hidden errors or warnings in the background execution.",
  "I am starting by checking the contents of the default project scratch directory to see if we have any existing projects.",
  // Numbered-prefix variant (agy sometimes lists narration items)
  "1. I will list the files and subdirectories located in /tmp/step4-smoke.",
  "2. I am reading the contents of the configuration file.",
];

/**
 * Legitimate assistant output that MUST pass through. The contract is
 * "English I will/am at line-start = pre-tool narration"; everything else
 * (German answers, prose that happens to contain "I will" mid-sentence,
 * code blocks, headers) stays intact.
 */
const ANTIGRAVITY_NARRATION_NEGATIVES = [
  // German legitimate Teto responses (the canonical user-facing language)
  "Ich habe den aktuellen Session- und Gateway-Status für OpenClaw geprüft.",
  "Hey! Bei mir ist alles super, ich bin startklar.",
  "Wie kann ich dir heute helfen?",
  "Möchtest du ein neues Projekt in unserem Arbeitsverzeichnis starten?",
  // Markdown structure (headers, code refs) — must never be matched
  "### Option C: Die 5-Ebenen-Aufteilung unserer Antigravity-Integration",
  // Lines that mention "I will" mid-sentence but do not start with it
  "Note that I will not run any tool here.",
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
