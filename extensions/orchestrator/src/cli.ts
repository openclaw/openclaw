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
import { formatShadowSummary, summariseShadow } from "./shadow-summary.js";
import { createStore } from "./store.js";
import {
  createSyntheticHarness,
  summariseRunResults,
  type SyntheticHarnessOptions,
} from "./synthetic.js";

export interface CliDependencies {
  /** Override stdout for tests. */
  out?: NodeJS.WritableStream;
  /** Override clock. */
  now?: () => number;
  /** Override credentials path. */
  credentialsPath?: string;
  /** Override synthetic-harness options for tests. */
  syntheticHarnessOptions?: SyntheticHarnessOptions;
  /** Override openclaw home for shadow-summary tests. */
  openclawHome?: string;
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

  orchestrator
    .command("synthetic <label>")
    .description(
      "Run a single synthetic-harness fixture end-to-end through the routing engine and store",
    )
    .action(async (label: string) => {
      const harness = createSyntheticHarness(deps.syntheticHarnessOptions ?? {});
      const result = harness.run(label);
      out.write(`${summariseRunResults([result])}\n`);
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  orchestrator
    .command("synthetic-all")
    .description(
      "Run every synthetic-harness fixture (R30 gate). Exits non-zero if any fixture fails.",
    )
    .action(async () => {
      const harness = createSyntheticHarness(deps.syntheticHarnessOptions ?? {});
      const results = harness.runAll();
      out.write(`${summariseRunResults(results)}\n`);
      if (results.some((r) => !r.ok)) {
        process.exitCode = 1;
      }
    });

  orchestrator
    .command("shadow-summary")
    .description(
      "Summarise the shadow-archive over a time window. Exits non-zero if any spawn failure landed inside the window — the live-flip gate.",
    )
    .option("--window <hours>", "Window in hours (default 24)", "24")
    .action(async (opts: { window?: string }) => {
      const windowHours = Number.parseInt(opts.window ?? "24", 10);
      const storeOptions: Parameters<typeof createStore>[0] = {};
      if (deps.openclawHome != null) {
        storeOptions.openclawHome = deps.openclawHome;
      }
      const store = createStore(storeOptions);
      const summaryOpts: Parameters<typeof summariseShadow>[0] = {
        store,
        windowHours: Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 24,
      };
      if (deps.now != null) summaryOpts.now = deps.now;
      const summary = summariseShadow(summaryOpts);
      out.write(`${formatShadowSummary(summary)}\n`);
      if (summary.failures > 0) {
        process.exitCode = 1;
      }
    });
}
