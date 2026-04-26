// `openclaw orchestrator <verb>` CLI surface. Currently:
//   - init          — generate the bearer token if missing
//   - rotate-token  — replace the bearer token in place
//
// Both verbs operate on `~/.openclaw/credentials/orchestrator-bearer.json`
// (recon A-B3). MC's `.env.local` mirror is intentionally NOT touched
// by these verbs — the recon documented best-effort mirror semantics
// but writing it implicitly would couple the openclaw extension to MC's
// repo layout. Operators run `openclaw orchestrator init` once, then
// paste the token into MC's `.env.local`. Future enhancement can add a
// `--mc-env <path>` flag.

import type { Command } from "commander";
import {
  defaultCredentialsPath,
  generateToken,
  tryReadCredentials,
  writeCredentials,
  type OrchestratorCredentials,
} from "./credentials.js";

export interface CliDependencies {
  /** Override stdout for tests. */
  out?: NodeJS.WritableStream;
  /** Override clock. */
  now?: () => number;
  /** Override credentials path. */
  credentialsPath?: string;
}

function describe(creds: OrchestratorCredentials, action: "created" | "rotated"): string {
  return [
    `Orchestrator bearer token ${action}.`,
    "",
    `  Path:       ${defaultCredentialsPath()}`,
    `  Created at: ${creds.createdAt}`,
    `  Token:      ${creds.token}`,
    "",
    "Mirror this token into Mission Control's `.env.local` as:",
    "",
    `  OPENCLAW_ORCHESTRATOR_TOKEN=${creds.token}`,
    "",
  ].join("\n");
}

export function registerOrchestratorCli(program: Command, deps: CliDependencies = {}): void {
  const out = deps.out ?? process.stdout;
  const orchestrator = program
    .command("orchestrator")
    .description("Manage the orchestrator routing layer (Phase B)");

  orchestrator
    .command("init")
    .description(
      "Generate the bearer token used by Mission Control to call the orchestrator HTTP API",
    )
    .option(
      "--force",
      "Replace an existing credentials file (does the same as rotate-token)",
      false,
    )
    .action(async (opts: { force?: boolean }) => {
      const path = deps.credentialsPath ?? defaultCredentialsPath();
      const existing = tryReadCredentials({ path });
      if (existing && !opts.force) {
        out.write(
          [
            `Orchestrator bearer token already exists at ${path}.`,
            "Run with --force to replace it, or `openclaw orchestrator rotate-token` for the same effect.",
            "",
          ].join("\n"),
        );
        process.exitCode = 1;
        return;
      }
      const credentials = writeCredentials({
        path,
        token: generateToken(),
        ...(deps.now != null ? { now: deps.now } : {}),
      });
      out.write(describe(credentials, "created"));
    });

  orchestrator
    .command("rotate-token")
    .description("Generate a fresh bearer token, replacing any existing one")
    .action(async () => {
      const path = deps.credentialsPath ?? defaultCredentialsPath();
      const credentials = writeCredentials({
        path,
        token: generateToken(),
        ...(deps.now != null ? { now: deps.now } : {}),
      });
      out.write(describe(credentials, "rotated"));
    });
}
