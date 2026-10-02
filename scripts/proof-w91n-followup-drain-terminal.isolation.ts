// Process isolation for the followup-drain proof harness.
//
// Imported first by `scripts/proof-w91n-followup-drain-terminal.ts` so it runs
// before any OpenClaw module body evaluates. Two invariants matter:
//
//  1. The scenario that drives the real reply path opens the OpenClaw state
//     database. Without an isolated home it would attach to the operator's live
//     `~/.openclaw/state/openclaw.sqlite`, which both mutates real state and
//     fails outright when that database is newer than this build.
//  2. A real production turn resolves provider credentials from the environment.
//     A developer shell usually exports them, so an un-scrubbed run would place a
//     live network call to a paid provider. Scrubbing here makes the harness
//     self-contained by construction: the only model endpoint it can reach is the
//     loopback server the scenario starts itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CREDENTIAL_ENV_PATTERN = /(API_KEY|AUTH_TOKEN|_TOKEN|_SECRET|_PASSWORD)$/i;

/** Env vars removed before any provider client can read them. */
export const scrubbedCredentialEnvNames: string[] = [];
for (const name of Object.keys(process.env)) {
  if (CREDENTIAL_ENV_PATTERN.test(name)) {
    delete process.env[name];
    scrubbedCredentialEnvNames.push(name);
  }
}

/** Throwaway OpenClaw home for this run; never the operator's real one. */
export const proofHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-w91n-home-"));
process.env.OPENCLAW_HOME = proofHomeDir;
process.env.OPENCLAW_STATE_DIR = path.join(proofHomeDir, "state");
fs.mkdirSync(process.env.OPENCLAW_STATE_DIR, { recursive: true });
