#!/usr/bin/env node
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const args = { file: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--file") {
      args.file = argv[++i] ?? args.file;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/agent-script-check.mjs --file <agent-script.json> [--json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!args.file) {
    throw new Error("--file is required");
  }
  return args;
}

function validate(script) {
  const findings = [];
  const states = Array.isArray(script.states) ? script.states : [];
  const stateIds = new Set(states.map((state) => state.id).filter(Boolean));
  const start = script.start;
  if (!script.name) {
    findings.push({ severity: "error", id: "name.missing", message: "Script name is required." });
  }
  if (!start || !stateIds.has(start)) {
    findings.push({
      severity: "error",
      id: "start.invalid",
      message: "Start state must reference an existing state.",
    });
  }
  if (states.length === 0) {
    findings.push({
      severity: "error",
      id: "states.empty",
      message: "At least one state is required.",
    });
  }

  for (const state of states) {
    if (!state.id) {
      findings.push({
        severity: "error",
        id: "state.id_missing",
        message: "Every state needs an id.",
      });
    }
    if (!["deterministic", "llm", "human"].includes(state.mode)) {
      findings.push({
        severity: "error",
        id: "state.mode_invalid",
        message: `${state.id ?? "unknown"} has invalid mode.`,
      });
    }
    for (const next of state.next ?? []) {
      if (!stateIds.has(next.to)) {
        findings.push({
          severity: "error",
          id: "transition.invalid",
          message: `${state.id} points to missing state ${next.to}.`,
        });
      }
    }
    if (
      state.mode === "llm" &&
      state.canChangeExternalState === true &&
      state.requiresApproval !== true
    ) {
      findings.push({
        severity: "error",
        id: "llm.external_state_unapproved",
        message: `${state.id} can change external state without approval.`,
      });
    }
  }

  const terminalStates = states.filter((state) => (state.next ?? []).length === 0);
  if (terminalStates.length === 0) {
    findings.push({
      severity: "warn",
      id: "terminal.missing",
      message: "No terminal state found.",
    });
  }
  return findings;
}

const args = parseArgs(process.argv.slice(2));
const script = JSON.parse(readFileSync(args.file, "utf8"));
const findings = validate(script);
const result = {
  file: args.file,
  ok: !findings.some((finding) => finding.severity === "error"),
  findings,
};
if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(result.ok ? "agent script ok" : "agent script invalid");
  for (const finding of findings) {
    console.log(`${finding.severity.toUpperCase()}: ${finding.id} - ${finding.message}`);
  }
}
process.exit(result.ok ? 0 : 1);
