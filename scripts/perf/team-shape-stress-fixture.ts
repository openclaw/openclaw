// The stress harness runs this fixture in a fresh process before starting each dist Gateway.
// Reuse the offline session/transcript/registry writers; never copy live state databases.
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

// Bundled modules exercise the real catalog without external-plugin preparation workers.
// Only the locally configured OpenAI mock receives model requests.
export const TEAM_STRESS_PLUGIN_IDS = [
  "acpx",
  "codex",
  "diagnostics-prometheus",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "github-copilot",
  "amazon-bedrock",
  "amazon-bedrock-mantle",
  "anthropic-vertex",
  "arcee",
  "baseten",
  "byteplus",
  "cerebras",
  "chutes",
  "cloudflare-ai-gateway",
  "cohere",
  "deepinfra",
  "deepseek",
  "fal",
  "featherless",
  "fireworks",
  "gmi",
  "groq",
  "huggingface",
  "kilocode",
  "venice",
  "longcat",
  "microsoft-foundry",
  "minimax",
  "mistral",
  "moonshot",
  "novita",
  "nvidia",
  "qianfan",
  "qwen",
  "stepfun",
  "together",
  "xai",
] as const;

export async function generateTeamShapeStressFixture(options: {
  stateDir: string;
  port: number;
  seed: number;
  now: number;
  sessions?: number;
  agents?: number;
  transcriptMiB?: number;
  longTranscriptEntries?: number;
  authAvailabilityStorm?: boolean;
  worktreeFiles?: number;
  worktreeFileBytes?: number;
  worktreeLocalOrigin?: boolean;
}) {
  const sessions = options.sessions ?? 10_800;
  if (!Number.isSafeInteger(sessions) || sessions < 100) {
    throw new Error("Stress fixtures require an integer session count >= 100");
  }
  return generateTeamShapeFixture(
    parseTeamShapeOptions([
      "--state-dir",
      options.stateDir,
      "--port",
      String(options.port),
      "--seed",
      String(options.seed),
      "--now",
      String(options.now),
      "--sessions",
      String(sessions),
      "--agents",
      String(options.agents ?? 4),
      "--runs",
      String(Math.floor((sessions * 4_300) / 10_800)),
      "--settled-runs",
      "--team-stress",
      ...(options.authAvailabilityStorm ? ["--auth-availability-storm"] : []),
      "--transcript-mib",
      String(options.transcriptMiB ?? 128),
      "--long-transcript-entries",
      String(options.longTranscriptEntries ?? 0),
      "--worktree-files",
      String(options.worktreeFiles ?? 0),
      "--worktree-file-bytes",
      String(options.worktreeFileBytes ?? 0),
      ...(options.worktreeLocalOrigin ? ["--worktree-local-origin"] : []),
      "--projects",
      "4",
      "--approvals",
      "24",
      "--cron",
      "40",
    ]),
  );
}
