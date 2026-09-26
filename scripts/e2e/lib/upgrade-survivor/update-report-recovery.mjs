import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { readPositiveIntEnv } from "../env-limits.mjs";
import {
  assertWorkerCellPackageIdentity,
  readWorkerCellPackageIdentity,
} from "./worker-cell-package.mjs";

const filename = fileURLToPath(import.meta.url);
const helper = path.resolve(path.dirname(filename), "../../../lib/openclaw-e2e-instance.sh");
const syntheticUrl = "https://github.com/openclaw/openclaw/issues/999999999";
const menu = "Choose the next action for this failed update";
const submit = "Submit this sanitized report to openclaw/openclaw now?";
const status = "Check whether this report was submitted to openclaw/openclaw?";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

function childOf(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function context(packageRoot) {
  const required = (key) => {
    assert(path.isAbsolute(process.env[key] ?? ""), `Missing isolated ${key}`);
    return fs.realpathSync(process.env[key]);
  };
  const runtime = required("OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT");
  const artifacts = required("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT");
  const state = required("OPENCLAW_STATE_DIR");
  const config = process.env.OPENCLAW_CONFIG_PATH;
  assert(childOf(runtime, state) && config && childOf(state, config));
  assert(
    process.env.OPENCLAW_E2E_COMMAND_TIMEOUT,
    "Pass the survivor COMMAND_TIMEOUT to the PTY helper",
  );
  assert(packageRoot && path.isAbsolute(packageRoot), "Missing installed package root");
  return {
    runtime,
    artifacts,
    state,
    config,
    packageRoot: fs.realpathSync(packageRoot),
    workspace: path.join(runtime, "update-report-workspace"),
    baseline: path.join(artifacts, "update-report-baseline.json"),
  };
}

function cliEnv() {
  const env = { ...process.env };
  for (const key of [
    "CI",
    "OPENCLAW_NO_PROMPT",
    "OPENCLAW_NO_ONBOARD",
    "VITEST",
    "NODE_ENV",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "HOMEBREW_GITHUB_API_TOKEN",
  ]) {
    delete env[key];
  }
  return env;
}

function runCli(ctx, label, args) {
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      'source "$1"; shift; openclaw_e2e_maybe_timeout "$OPENCLAW_E2E_COMMAND_TIMEOUT" "$@"',
      "update-report-cli",
      helper,
      process.execPath,
      path.join(ctx.packageRoot, "openclaw.mjs"),
      ...args,
    ],
    { env: cliEnv(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  fs.writeFileSync(path.join(ctx.artifacts, `update-report-${label}.log`), result.stdout ?? "", {
    flag: "wx",
  });
  fs.writeFileSync(path.join(ctx.artifacts, `update-report-${label}.err`), result.stderr ?? "", {
    flag: "wx",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Installed CLI ${label} failed: ${result.stderr}`);
  return result.stdout;
}

function setup(ctx) {
  const identity = readWorkerCellPackageIdentity(ctx.packageRoot);
  assert.equal(identity.version, "2026.9.6", "This cell starts from the published 9.6 driver");
  assert.equal(identity.buildInfo.commit, "eb377ac59e6c9fd6c7705028034812becf00271b");
  fs.mkdirSync(ctx.workspace, { recursive: true });
  const sentinel = path.join(ctx.workspace, "operator-note.txt");
  fs.writeFileSync(sentinel, "Operator content must survive update report recovery.\n", {
    flag: "wx",
  });
  runCli(ctx, "setup-gateway", ["config", "set", "gateway.mode", "local"]);
  runCli(ctx, "setup-workspace", ["config", "set", "agents.defaults.workspace", ctx.workspace]);
  writeJson(ctx.baseline, {
    baseline: {
      version: identity.version,
      buildInfo: identity.buildInfo,
      payloadSha256: hash(JSON.stringify(identity)),
    },
    config: ctx.config,
    workspace: ctx.workspace,
    sentinel,
    sentinelSha256: hash(fs.readFileSync(sentinel)),
  });
}

async function fakeGh(cell, callsFile, args) {
  assert(["retry", "pending"].includes(cell));
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const previous = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const auth = ["auth", "status", "--active", "--hostname", "github.com"];
  const create = [
    "api",
    "--hostname",
    "github.com",
    "--include",
    "--method",
    "POST",
    "repos/openclaw/openclaw/issues",
    "--input",
    "-",
    "--jq",
    ".html_url",
  ];
  let call;
  if (JSON.stringify(args) === JSON.stringify(auth)) {
    assert.equal(input, "");
    call = { kind: "auth", args };
  } else if (JSON.stringify(args) === JSON.stringify(create)) {
    const body = JSON.parse(input);
    assert.equal(typeof body.title, "string");
    assert.equal(typeof body.body, "string");
    const marker = body.body.match(/<!-- (openclaw-report:[a-f0-9]{64}) -->/u)?.[1];
    assert(marker, "POST lacks the product's report marker");
    call = { kind: "create", args, ...body, marker };
  } else {
    assert.deepEqual(args.slice(0, 7), [
      "issue",
      "list",
      "--repo",
      "github.com/openclaw/openclaw",
      "--state",
      "all",
      "--search",
    ]);
    assert.deepEqual(args.slice(8), ["--limit", "100", "--json", "url,title,body"]);
    assert.equal(input, "");
    const marker = args[7].match(/^"(openclaw-report:[a-f0-9]{64})" in:body$/u)?.[1];
    assert(marker);
    call = { kind: "lookup", args, marker };
  }
  fs.appendFileSync(callsFile, `${JSON.stringify(call)}\n`);
  if (call.kind === "lookup") {
    process.stdout.write("[]\n");
  } else if (call.kind === "create") {
    const first = !previous.some((entry) => entry.kind === "create");
    if (cell === "pending" || first) {
      process.stdout.write(`HTTP/2 ${cell === "pending" ? 500 : 422}\n\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`HTTP/2 201\n\n${syntheticUrl}\n`);
    }
  }
}

function dialogue(cell) {
  const choose = (label, keys = "\x1b[B\r") => ({
    kind: "menu",
    label,
    keys,
    test: (text) => text.includes(menu) && /(?:^|\n)[^\n]*Exit(?:\r?\n|$)/u.test(text),
  });
  const confirm = (message) => ({
    kind: "confirm",
    keys: "y",
    test: (text) => text.includes(message) && /Yes[^\n]*No/u.test(text),
  });
  return [
    choose("Report update failure"),
    confirm(submit),
    ...(cell === "retry"
      ? [choose("Report update failure"), confirm(submit)]
      : [
          choose("Check report status"),
          confirm(status),
          choose("Check report status", "\x1b[B\x1b[B\r"),
        ]),
  ];
}

async function drivePty(ctx, cell, bin, missing) {
  const outputMaxBytes = readPositiveIntEnv("OPENCLAW_E2E_PTY_OUTPUT_MAX_BYTES", 16 * 1024 * 1024);
  const transcript = path.join(ctx.artifacts, `update-report-${cell}.pty.log`);
  const footer = `OPENCLAW_REPORT_CLI_EXIT_${cell}=`;
  const geometry = `OPENCLAW_REPORT_PTY_SIZE_${cell}=`;
  // Piped script(1) can inherit zero kernel dimensions; COLUMNS/LINES do not resize its PTY.
  const prelude = [
    "stty cols 160 rows 50 || exit $?",
    "report_size=$(stty size) || exit $?",
    `printf '\\n${geometry}%s\\n' "$report_size"`,
    '[ "$report_size" = "50 160" ] || exit 1',
  ].join("; ");
  // script(1) on Linux does not propagate the child status without -e.
  const command = `${[process.execPath, path.join(ctx.packageRoot, "openclaw.mjs"), "update", "--tag", `file:${missing}`, "--no-restart"].map(quote).join(" ")}; report_exit=$?; printf '\n${footer}%s\n' "$report_exit"; exit "$report_exit"`;
  const child = spawn(
    "/bin/bash",
    [
      "-c",
      'source "$1"; openclaw_e2e_run_script_with_pty "$2" "$3"',
      "update-report-pty",
      helper,
      `${prelude}; ${command}`,
      transcript,
    ],
    {
      env: {
        ...cliEnv(),
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        TERM: "xterm-256color",
        COLUMNS: "160",
        LINES: "50",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const steps = dialogue(cell);
  const output = [];
  let raw = "",
    outputBytes = 0,
    offset = 0,
    completed = 0;
  /** @type {Error | undefined} */
  let failure;
  const stop = (error) => {
    if (failure) {
      return;
    }
    failure = error instanceof Error ? error : new Error("Report proof failed", { cause: error });
    // Let the maintained helper own its timeout and join its actual child close.
    if (!child.stdin.destroyed) {
      child.stdin.write("\x03");
    }
  };
  const interrupted = (signal) => stop(new Error(`Report proof interrupted by ${signal}`));
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const listener = () => interrupted(signal);
    process.on(signal, listener);
    return [signal, listener];
  });
  child.stdin.on("error", (error) => stop(error));
  child.on("error", stop);
  const consume = (chunk) => {
    const remaining = outputMaxBytes - outputBytes;
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      output.push(retained);
      outputBytes += retained.length;
      raw = Buffer.concat(output, outputBytes).toString("utf8");
    }
    if (chunk.length > remaining) {
      stop(new Error(`PTY output exceeded OPENCLAW_E2E_PTY_OUTPUT_MAX_BYTES (${outputMaxBytes})`));
      return;
    }
    if (failure || completed === steps.length) {
      return;
    }
    try {
      const clean = stripVTControlCharacters(raw).replaceAll("\r", "");
      const fresh = clean.slice(offset);
      const step = steps[completed];
      if (!step.test(fresh)) {
        return;
      }
      if (step.kind === "menu") {
        const menuOffset = fresh.lastIndexOf(menu);
        assert(
          fresh.includes(step.label, menuOffset),
          `Expected ${step.label} in the current menu`,
        );
        if (step.label === "Check report status") {
          assert(
            !fresh.includes("Report update failure", menuOffset),
            "Pending report offered another POST",
          );
          assert(
            !fresh.includes("Report in browser", menuOffset),
            "Pending report offered browser publication",
          );
        }
      }
      offset = clean.length;
      completed++;
      child.stdin.write(step.keys);
    } catch (error) {
      stop(error);
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  const outcome = await new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.destroy();
  for (const [signal, listener] of signals) {
    process.removeListener(signal, listener);
  }
  fs.writeFileSync(
    path.join(ctx.artifacts, `update-report-${cell}.output.log`),
    Buffer.concat(output, outputBytes),
    { flag: "wx" },
  );
  if (failure) {
    throw failure;
  }
  assert.equal(outcome.signal, null, "PTY helper was interrupted");
  assert.equal(completed, steps.length, `PTY stopped before dialogue step ${completed + 1}`);
  const clean = stripVTControlCharacters(raw).replaceAll("\r", "");
  const dimensions = [...clean.matchAll(new RegExp(`^${geometry}([^\\n]+)$`, "gmu"))];
  assert.deepEqual(
    dimensions.map((match) => match[1]),
    ["50 160"],
    "PTY kernel size was not verified",
  );
  const exits = [...clean.matchAll(new RegExp(`^${footer}(\\d+)$`, "gmu"))];
  assert.equal(exits.length, 1, "Missing or repeated actual CLI exit footer");
  assert.equal(Number(exits[0][1]), 1, "Failed update must retain exit code 1 after reporting");
  assert([0, 1].includes(outcome.code), "PTY helper failed independently of the CLI");
  if (cell === "retry") {
    assert(clean.includes(`Created GitHub issue: ${syntheticUrl}`));
  }
  return {
    cliExitCode: 1,
    helperExitCode: outcome.code,
    promptActions: completed,
    ptyRows: 50,
    ptyColumns: 160,
  };
}

function inspectCalls(callsFile, cell) {
  const calls = fs.readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse);
  const creates = calls.filter((call) => call.kind === "create");
  const lookups = calls.filter((call) => call.kind === "lookup");
  assert.equal(creates.length, cell === "retry" ? 2 : 1);
  assert.equal(lookups.length, cell === "retry" ? 0 : 2);
  assert.equal(calls.filter((call) => call.kind === "auth").length, creates.length);
  for (const entry of creates) {
    assert.equal(entry.title, creates[0].title);
    assert.equal(entry.body, creates[0].body);
    assert.equal(entry.marker, creates[0].marker);
  }
  for (const entry of lookups) {
    assert.equal(entry.marker, creates[0].marker);
  }
  return {
    creates,
    marker: creates[0].marker,
    bodySha256: hash(creates[0].body),
    lookupCount: lookups.length,
  };
}

async function run(ctx) {
  const baseline = readJson(ctx.baseline);
  assert.equal(baseline.config, ctx.config);
  assert.equal(baseline.workspace, ctx.workspace);
  assert.equal(hash(fs.readFileSync(baseline.sentinel)), baseline.sentinelSha256);
  assert(
    fs.existsSync(path.join(ctx.state, "state/openclaw.sqlite")),
    "Candidate must have established state before report proof",
  );
  const expected = readJson(path.join(ctx.artifacts, "candidate-package-identity.json"));
  const identity = readWorkerCellPackageIdentity(ctx.packageRoot);
  assertWorkerCellPackageIdentity(identity, {
    version: expected.version,
    buildInfo: expected.buildInfo,
    files: expected.files,
  });
  const configHash = hash(fs.readFileSync(ctx.config));
  const fixture = fs.mkdtempSync(path.join(ctx.runtime, "update-report-"));
  const missing = path.join(fixture, "missing-candidate.tgz");
  assert(!fs.existsSync(missing));
  const results = [];
  for (const cell of ["retry", "pending"]) {
    const bin = path.join(fixture, cell);
    fs.mkdirSync(bin);
    const callsFile = path.join(ctx.artifacts, `update-report-${cell}.gh.jsonl`);
    fs.writeFileSync(callsFile, "", { flag: "wx" });
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh\nexec ${[process.execPath, filename, "gh", cell, callsFile].map(quote).join(" ")} "$@"\n`,
      { mode: 0o700, flag: "wx" },
    );
    const pty = await drivePty(ctx, cell, bin, missing);
    const calls = inspectCalls(callsFile, cell);
    const state = JSON.parse(runCli(ctx, `${cell}-status`, ["update", "status", "--json"]));
    assert.equal(state.activeRun, undefined);
    assert.equal(state.runStatusError, undefined);
    assert.equal(state.lastRun?.status, "failed");
    assert.equal(state.lastRun.reason, "global-install-failed");
    const failedSteps = ["global update", "global update (omit optional)"].map((name) => {
      const step = state.lastRun.steps.find((entry) => entry.step === name);
      assert.equal(step?.status, "failed", `Missing real npm failure step ${name}`);
      assert(
        step.failureFacts?.some((fact) => fact.code === "ENOENT"),
        `Missing real npm ENOENT for ${name}`,
      );
      return step;
    });
    assert(
      !state.lastRun.steps.some((step) => step.step === "package-swap"),
      "Failed staging activated a package",
    );
    assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(ctx.packageRoot), identity);
    assert.equal(
      hash(fs.readFileSync(ctx.config)),
      configHash,
      "Failed report flow rewrote operator config",
    );
    assert.equal(hash(fs.readFileSync(baseline.sentinel)), baseline.sentinelSha256);
    let retainedReport;
    if (cell === "pending") {
      const directory = path.join(ctx.state, "update-reports");
      const reports = fs.readdirSync(directory).filter((name) => name.endsWith(".md"));
      const matching = reports.filter(
        (name) => fs.readFileSync(path.join(directory, name), "utf8") === calls.creates[0].body,
      );
      assert.equal(
        matching.length,
        1,
        "Uncertain submission must retain its exact sanitized report",
      );
      retainedReport = { file: matching[0], sha256: calls.bodySha256 };
    }
    results.push({
      cell,
      ...pty,
      runId: state.lastRun.runId,
      reason: state.lastRun.reason,
      failedSteps,
      marker: calls.marker,
      bodySha256: calls.bodySha256,
      postCount: calls.creates.length,
      lookupCount: calls.lookupCount,
      retainedReport,
    });
  }
  assert.notEqual(results[0].runId, results[1].runId);
  writeJson(path.join(ctx.artifacts, "update-report-recovery.json"), {
    baseline: baseline.baseline,
    candidate: {
      version: identity.version,
      buildInfo: identity.buildInfo,
      payloadSha256: hash(JSON.stringify(identity)),
    },
    configSha256: configHash,
    operatorSentinelSha256: baseline.sentinelSha256,
    results,
  });
}

const [mode, first, second, ...args] = process.argv.slice(2);
if (mode === "gh") {
  await fakeGh(first, second, args);
} else if (mode === "setup") {
  setup(context(first));
} else if (mode === "run") {
  await run(context(first));
} else {
  throw new Error("Expected setup <package-root> or run <package-root>");
}
