// Agent OS WS13 — L1 minimal proof runner (approved minimal command target).
//
// Not a Gate. Does not start Gateway/runtime, register hooks, or send any
// message. Runs the deterministic in-memory scenarios A-G and prints the
// sanitized metadata-only markdown evidence to stdout.

import { runWs13Scenarios } from "../src/ws13/index.js";
import { renderEvidenceMarkdown } from "../src/ws13/proof-recorder.js";

const proof = runWs13Scenarios();

// Compact metadata-only summary line for quick scanning.
const summary = proof.results
  .map((r) => `${r.scenario}=${r.status}`)
  .join(" ");
process.stderr.write(
  `WS13 L1 overallStatus=${proof.overallStatus} | ${summary}\n`,
);

process.stdout.write(`${renderEvidenceMarkdown(proof)}\n`);
