import {
  createExecutionArtifacts,
  executePlan,
  formatExplanation,
  formatPlanOutput,
} from "./test-planner/executor.mjs";
import {
  buildCIExecutionManifest,
  buildExecutionPlan,
  explainExecutionTarget,
} from "./test-planner/planner.mjs";

const parseCliArgs = (args) => {
  const wrapper = {
    ciManifest: false,
    failurePolicy: null,
    plan: false,
    explain: null,
    mode: null,
    profile: null,
    surfaces: [],
    files: [],
    passthroughArgs: [],
    showHelp: false,
  };
  let passthroughMode = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--collect-failures") {
      wrapper.failurePolicy = "collect-all";
      continue;
    }
    if (arg === "--failure-policy") {
      const nextValue = args[index + 1] ?? "";
      if (nextValue === "fail-fast" || nextValue === "collect-all") {
        wrapper.failurePolicy = nextValue;
        index += 1;
        continue;
      }
      throw new Error(`Invalid --failure-policy value: ${String(nextValue || "<missing>")}`);
    }
    if (arg.startsWith("--failure-policy=")) {
      const value = arg.slice("--failure-policy=".length);
      if (value === "fail-fast" || value === "collect-all") {
        wrapper.failurePolicy = value;
        continue;
      }
      throw new Error(`Invalid --failure-policy value: ${String(value || "<missing>")}`);
    }
    if (passthroughMode) {
      wrapper.passthroughArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      passthroughMode = true;
      continue;
    }
    if (arg === "--plan") {
      wrapper.plan = true;
      continue;
    }
    if (arg === "--ci-manifest") {
      wrapper.ciManifest = true;
      continue;
    }
    if (arg === "--help") {
      wrapper.showHelp = true;
      continue;
    }
    if (arg === "--mode") {
      const nextValue = args[index + 1] ?? null;
      if (nextValue === "ci" || nextValue === "local") {
        wrapper.mode = nextValue;
        index += 1;
        continue;
      }
    }
    if (arg === "--profile") {
      const nextValue = args[index + 1] ?? "";
      if (!nextValue || nextValue === "--" || nextValue.startsWith("-")) {
        throw new Error(`Invalid --profile value: ${String(nextValue || "<missing>")}`);
      }
      wrapper.profile = nextValue;
      index += 1;
      continue;
    }
    if (arg === "--surface") {
      const nextValue = args[index + 1] ?? "";
      if (!nextValue || nextValue === "--" || nextValue.startsWith("-")) {
        throw new Error(`Invalid --surface value: ${String(nextValue || "<missing>")}`);
      }
      wrapper.surfaces.push(nextValue);
      index += 1;
      continue;
    }
    if (arg === "--files") {
      const nextValue = args[index + 1] ?? "";
      if (!nextValue || nextValue === "--" || nextValue.startsWith("-")) {
        throw new Error(`Invalid --files value: ${String(nextValue || "<missing>")}`);
      }
      wrapper.files.push(nextValue);
      index += 1;
      continue;
    }
    if (arg === "--explain") {
      const nextValue = args[index + 1] ?? "";
      if (!nextValue || nextValue === "--" || nextValue.startsWith("-")) {
        throw new Error(`Invalid --explain value: ${String(nextValue || "<missing>")}`);
      }
      wrapper.explain = nextValue;
      index += 1;
      continue;
    }
    wrapper.passthroughArgs.push(arg);
  }
  return wrapper;
};

const exitWithCleanup = (artifacts, code) => {
  artifacts?.cleanupTempArtifacts?.();
  process.exit(code);
};

let rawCli;
try {
  rawCli = parseCliArgs(process.argv.slice(2));
} catch (error) {
  console.error(`[test-parallel] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
if (rawCli.showHelp) {
  console.log(
    [
      "Usage: node scripts/test-parallel.mjs [wrapper flags] [-- vitest args]",
      "",
      "Runs the planner-backed OpenClaw test wrapper.",
      "",
      "Wrapper flags:",
      "  --plan                 Print the resolved execution plan and exit",
      "  --ci-manifest          Print the planner-backed CI execution manifest as JSON and exit",
      "  --explain <file>       Explain how a file is classified and run, then exit",
      "  --surface <name>       Select a surface: unit, extensions, channels, contracts, gateway",
      "  --files <pattern>      Add targeted files or path patterns (repeatable)",
      "  --mode <ci|local>      Override runtime mode",
      "  --profile <name>       Override execution intent: normal, max, serial",
      "  --failure-policy <name> Override execution failure policy: fail-fast, collect-all",
      "  --collect-failures     Shortcut for --failure-policy collect-all",
      "  --help                 Show this help text",
      "",
      "Examples:",
      "  node scripts/test-parallel.mjs",
      "  node scripts/test-parallel.mjs --plan --surface unit --surface extensions",
      "  node scripts/test-parallel.mjs --explain src/auto-reply/reply/followup-runner.test.ts",
      "  node scripts/test-parallel.mjs --collect-failures --surface unit",
      "  node scripts/test-parallel.mjs --files src/foo.test.ts -- --reporter=dot",
      "",
      "Environment:",
      "  OPENCLAW_TEST_LIST_LANES=1          Print the resolved plan before execution",
      "  OPENCLAW_TEST_SHOW_POOL_DECISION=1  Include thread/fork pool decisions in diagnostics",
    ].join("\n"),
  );
  process.exit(0);
}

const request = {
  failurePolicy: rawCli.failurePolicy,
  mode: rawCli.mode,
  profile: rawCli.profile,
  surfaces: rawCli.surfaces,
  fileFilters: rawCli.files,
  passthroughArgs: rawCli.passthroughArgs,
};

if (rawCli.explain) {
  const explanation = explainExecutionTarget(
    { ...request, passthroughArgs: [], fileFilters: [rawCli.explain] },
    { env: process.env },
  );
  console.log(formatExplanation(explanation));
  process.exit(0);
}

if (rawCli.ciManifest) {
  const manifest = buildCIExecutionManifest(undefined, { env: process.env });
  console.log(`${JSON.stringify(manifest, null, 2)}\n`);
  process.exit(0);
}

const artifacts = createExecutionArtifacts(process.env);
let plan;
try {
  plan = buildExecutionPlan(request, {
    env: process.env,
    writeTempJsonArtifact: artifacts.writeTempJsonArtifact,
  });
} catch (error) {
  console.error(`[test-parallel] ${error instanceof Error ? error.message : String(error)}`);
  exitWithCleanup(artifacts, 2);
}

if (process.env.OPENCLAW_TEST_LIST_LANES === "1" || rawCli.plan) {
  console.log(formatPlanOutput(plan));
  exitWithCleanup(artifacts, 0);
}

const result = await executePlan(plan, { env: process.env, artifacts });
process.exit(typeof result === "number" ? result : result.exitCode);
