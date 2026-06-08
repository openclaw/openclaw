// Google plugin module implements cli backend behavior.
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";

const GEMINI_MODEL_ALIASES: Record<string, string> = {
  pro: "gemini-3.1-pro-preview",
  flash: "gemini-3.1-flash-preview",
  "flash-lite": "gemini-3.1-flash-lite",
};
const GEMINI_CLI_DEFAULT_MODEL_REF = "google-gemini-cli/gemini-3-flash-preview";
const ANTIGRAVITY_MODEL_ALIASES: Record<string, string> = {
  pro: "gemini-3.1-pro-preview",
  flash: "gemini-3.5-flash",
};
const ANTIGRAVITY_CLI_DEFAULT_MODEL_REF = "google-antigravity-cli/gemini-3.5-flash";

/**
 * agy emits a pre-tool narration line ("I will list/read/view/check/search/edit/…
 * the foo at /bar.") before each native tool call. These sentences leak into the
 * assistant output and add no value for OpenClaw users that already see the tool
 * card. The pattern is intentionally narrow: it only matches an "I will" line
 * that starts with a known tool verb followed by a short lowercase object phrase
 * and a sentence-ending period, so legitimate user-facing "I will …" sentences
 * stay untouched.
 */
const ANTIGRAVITY_PRE_TOOL_NARRATION =
  /^I will (list|read|view|check|search|edit|open|run|create|delete|write) [a-z][^\n]{2,120}\.\s*$/gim;

export function buildGoogleGeminiCliBackend(): CliBackendPlugin {
  return {
    id: "google-gemini-cli",
    modelProvider: "google",
    liveTest: {
      defaultModelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: true,
      defaultMcpProbe: true,
      docker: {
        npmPackage: "@google/gemini-cli",
        binaryName: "gemini",
      },
    },
    bundleMcp: true,
    bundleMcpMode: "gemini-system-settings",
    nativeToolMode: "always-on",
    config: {
      command: "gemini",
      args: ["--skip-trust", "--output-format", "json", "--prompt", "{prompt}"],
      resumeArgs: [
        "--skip-trust",
        "--resume",
        "{sessionId}",
        "--output-format",
        "json",
        "--prompt",
        "{prompt}",
      ],
      output: "json",
      input: "arg",
      imageArg: "@",
      imagePathScope: "workspace",
      modelArg: "--model",
      modelAliases: GEMINI_MODEL_ALIASES,
      sessionMode: "existing",
      sessionIdFields: ["session_id", "sessionId"],
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}

export function buildGoogleAntigravityCliBackend(): CliBackendPlugin {
  return {
    id: "google-antigravity-cli",
    modelProvider: "google",
    liveTest: {
      defaultModelRef: ANTIGRAVITY_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: false,
      defaultMcpProbe: false,
      docker: {
        binaryName: "agy",
      },
    },
    nativeToolMode: "always-on",
    textTransforms: {
      output: [{ from: ANTIGRAVITY_PRE_TOOL_NARRATION, to: "" }],
    },
    config: {
      command: "agy",
      args: ["--print", "{prompt}"],
      output: "text",
      input: "arg",
      modelArg: "--model",
      modelAliases: ANTIGRAVITY_MODEL_ALIASES,
      sessionMode: "none",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}
