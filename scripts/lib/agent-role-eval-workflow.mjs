import { spawnSync } from "node:child_process";
import fs from "node:fs";
import {
  DEFAULT_LIVE_AGENT_ROLE_EVAL_AGENTS,
  DEFAULT_SELF_CONTAINED_LIVE_MODEL,
  DEFAULT_SELF_CONTAINED_OLLAMA_MIN_MEM_MB,
} from "./agent-role-evals.mjs";

export const OLLAMA_CONTAINER_NAME = "openclaw-agent-role-eval-ollama";
export const DEFAULT_LIVE_AGENT_ROLE_EVAL_TIMEOUT_SECONDS = 180;
export const DEFAULT_LIVE_AGENT_ROLE_EVAL_REPORT_DIR = "artifacts/agent-role-evals";

function firstNonBlank(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function parseInteger(value, label, { min = 1 } = {}) {
  const text = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`${label} must be an integer; got ${JSON.stringify(value)}.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`${label} must be at least ${min}; got ${JSON.stringify(value)}.`);
  }
  return parsed;
}

export function normalizeLiveAgentList(value, fallback = DEFAULT_LIVE_AGENT_ROLE_EVAL_AGENTS) {
  const source = firstNonBlank(value, fallback.join(","));
  const agents = [
    ...new Set(
      String(source)
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  if (agents.length === 0) {
    throw new Error("At least one live agent id is required.");
  }
  return agents;
}

export function isOllamaModelRef(modelRef) {
  return typeof modelRef === "string" && /^ollama\/.+/.test(modelRef.trim());
}

export function ollamaModelId(modelRef) {
  const normalized = String(modelRef ?? "").trim();
  if (!isOllamaModelRef(normalized)) {
    throw new Error(`Expected an ollama/<model> ref; got ${JSON.stringify(modelRef)}.`);
  }
  return normalized.slice("ollama/".length);
}

export function resolveLiveWorkflowConfig(env = process.env) {
  const model =
    firstNonBlank(
      env.INPUT_LIVE_MODEL,
      env.OPENCLAW_AGENT_EVAL_LIVE_MODEL,
      DEFAULT_SELF_CONTAINED_LIVE_MODEL,
    ) ?? DEFAULT_SELF_CONTAINED_LIVE_MODEL;
  return {
    model,
    agents: normalizeLiveAgentList(
      firstNonBlank(env.INPUT_LIVE_AGENTS, env.OPENCLAW_AGENT_EVAL_LIVE_AGENTS),
    ),
    timeoutSeconds: parseInteger(
      firstNonBlank(
        env.INPUT_TIMEOUT_SECONDS,
        String(DEFAULT_LIVE_AGENT_ROLE_EVAL_TIMEOUT_SECONDS),
      ),
      "Live eval timeout seconds",
    ),
    ollamaMinMemMb: parseInteger(
      firstNonBlank(
        env.INPUT_OLLAMA_MIN_MEM_MB,
        env.OPENCLAW_AGENT_EVAL_OLLAMA_MIN_MEM_MB,
        String(DEFAULT_SELF_CONTAINED_OLLAMA_MIN_MEM_MB),
      ),
      "Ollama minimum memory MiB",
      { min: 0 },
    ),
    bootstrapOllama: firstNonBlank(env.OPENCLAW_AGENT_EVAL_BOOTSTRAP_OLLAMA, "1") !== "0",
  };
}

export function resolveRunLiveWorkflowConfig(env = process.env) {
  const config = resolveLiveWorkflowConfig(env);
  return {
    ...config,
    model: firstNonBlank(env.OPENCLAW_AGENT_ROLE_EVAL_RESOLVED_MODEL, config.model) ?? config.model,
  };
}

function run(command, args, { spawn = spawnSync, stdio = "inherit", ignoreFailure = false } = {}) {
  const result = spawn(command, args, { stdio, encoding: "utf8" });
  const status = result.status ?? (result.error ? 1 : 0);
  if (status !== 0 && !ignoreFailure) {
    if (result.error) {
      throw result.error;
    }
    return status;
  }
  return status;
}

function capture(command, args, { spawn = spawnSync } = {}) {
  const result = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function writeGitHubEnv(env, key, value) {
  if (!env.GITHUB_ENV) {
    return;
  }
  fs.appendFileSync(env.GITHUB_ENV, `${key}=${value}\n`, "utf8");
}

function sanitizeReportName(value) {
  return (
    String(value ?? "unknown")
      .trim()
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "unknown"
  );
}

function maybeReportDir(env) {
  const value = firstNonBlank(
    env.OPENCLAW_AGENT_ROLE_EVAL_REPORT_DIR,
    env.GITHUB_WORKSPACE
      ? `${env.GITHUB_WORKSPACE}/${DEFAULT_LIVE_AGENT_ROLE_EVAL_REPORT_DIR}`
      : undefined,
  );
  return value ? value : undefined;
}

function tailText(value, maxLength = 4000) {
  const text = String(value ?? "");
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function parseLiveEvalJson(stdout) {
  const text = String(stdout ?? "").trim();
  try {
    if (text.startsWith("{")) {
      return JSON.parse(text);
    }
    for (const marker of ['{\n  "ok"', '{"ok"']) {
      const index = text.indexOf(marker);
      if (index >= 0) {
        return JSON.parse(text.slice(index));
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function liveReportLine(entry) {
  const model = entry.provider && entry.model ? ` ${entry.provider}/${entry.model}` : "";
  const duration = entry.durationMs ? ` ${entry.durationMs}ms` : "";
  return `- ${entry.ok ? "PASS" : "FAIL"} ${entry.agentId}${model}${duration}`;
}

function writeLiveWorkflowReport(reportDir, report, env) {
  fs.mkdirSync(reportDir, { recursive: true });
  const summaryJson = `${JSON.stringify(report, null, 2)}\n`;
  const summaryMd = [
    "# Agent Role Live Eval Report",
    "",
    `- Status: ${report.ok ? "passed" : "failed"}`,
    `- Model: ${report.model}`,
    `- Timeout seconds: ${report.timeoutSeconds}`,
    `- Agents requested: ${report.agentsRequested.join(", ")}`,
    `- Agents completed: ${report.results.length}`,
    "",
    "## Results",
    "",
    ...report.results.map(liveReportLine),
    "",
  ].join("\n");
  fs.writeFileSync(`${reportDir}/summary.json`, summaryJson, "utf8");
  fs.writeFileSync(`${reportDir}/summary.md`, summaryMd, "utf8");
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMd, "utf8");
  }
}

function readJsonFile(filePath, issues, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    issues.push(
      `${label} is missing or invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function verifyLiveWorkflowReport({ env = process.env, reportDir } = {}) {
  const resolvedReportDir = reportDir ?? maybeReportDir(env);
  const issues = [];
  if (!resolvedReportDir) {
    return {
      ok: false,
      reportDir: undefined,
      issues: ["No live eval report directory was provided."],
    };
  }
  let expectedConfig;
  try {
    expectedConfig = resolveRunLiveWorkflowConfig(env);
  } catch (error) {
    issues.push(
      `Could not resolve expected live eval workflow inputs: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const summary = readJsonFile(`${resolvedReportDir}/summary.json`, issues, "summary.json");
  if (!summary) {
    return { ok: false, reportDir: resolvedReportDir, issues };
  }

  if (summary.ok !== true) {
    issues.push("summary.json reports a failed live eval.");
  }
  if (!isNonBlankString(summary.model)) {
    issues.push("summary.json is missing model.");
  }
  if (!Number.isSafeInteger(summary.timeoutSeconds) || summary.timeoutSeconds <= 0) {
    issues.push("summary.json has invalid timeoutSeconds.");
  }
  if (expectedConfig && summary.model !== expectedConfig.model) {
    issues.push(
      `summary.json model ${JSON.stringify(summary.model)} does not match expected ${JSON.stringify(expectedConfig.model)}.`,
    );
  }
  if (expectedConfig && summary.timeoutSeconds !== expectedConfig.timeoutSeconds) {
    issues.push(
      `summary.json timeoutSeconds ${JSON.stringify(summary.timeoutSeconds)} does not match expected ${expectedConfig.timeoutSeconds}.`,
    );
  }
  if (!isNonBlankString(summary.startedAt) || !isNonBlankString(summary.completedAt)) {
    issues.push("summary.json is missing startedAt or completedAt.");
  }

  const requested = Array.isArray(summary.agentsRequested) ? summary.agentsRequested : [];
  const results = Array.isArray(summary.results) ? summary.results : [];
  if (
    expectedConfig &&
    (requested.length !== expectedConfig.agents.length ||
      requested.some((agentId, index) => agentId !== expectedConfig.agents[index]))
  ) {
    issues.push(
      `summary.json agentsRequested ${JSON.stringify(requested)} does not match expected ${JSON.stringify(expectedConfig.agents)}.`,
    );
  }
  if (requested.length === 0 || requested.some((agentId) => !isNonBlankString(agentId))) {
    issues.push("summary.json has no valid agentsRequested list.");
  }
  if (results.length !== requested.length) {
    issues.push(
      `summary.json result count ${results.length} does not match requested count ${requested.length}.`,
    );
  }

  const resultIds = results.map((entry) => entry?.agentId).filter(isNonBlankString);
  const duplicateIds = resultIds.filter((agentId, index) => resultIds.indexOf(agentId) !== index);
  if (duplicateIds.length > 0) {
    issues.push(`summary.json has duplicate result ids: ${[...new Set(duplicateIds)].join(", ")}.`);
  }
  for (const agentId of requested) {
    if (!resultIds.includes(agentId)) {
      issues.push(`summary.json is missing result for ${agentId}.`);
    }
  }
  for (const agentId of resultIds) {
    if (!requested.includes(agentId)) {
      issues.push(`summary.json has unexpected result for ${agentId}.`);
    }
  }

  for (const entry of results) {
    const agentId = entry?.agentId;
    if (!isNonBlankString(agentId)) {
      issues.push("summary.json has a result without agentId.");
      continue;
    }
    if (entry.ok !== true) {
      issues.push(`${agentId} result is not passing.`);
    }
    if (entry.status !== 0) {
      issues.push(`${agentId} result status is ${JSON.stringify(entry.status)} instead of 0.`);
    }
    if (!isNonBlankString(entry.provider) || !isNonBlankString(entry.model)) {
      issues.push(`${agentId} result is missing provider or model.`);
    }
    if (entry.ok === true && entry.error) {
      issues.push(`${agentId} passing result unexpectedly includes error text.`);
    }
    if (Array.isArray(entry.issues) && entry.issues.length > 0) {
      issues.push(`${agentId} result has evaluator issues: ${entry.issues.join("; ")}`);
    }

    const safeAgentId = sanitizeReportName(agentId);
    const agentJson = readJsonFile(
      `${resolvedReportDir}/${safeAgentId}.json`,
      issues,
      `${safeAgentId}.json`,
    );
    const rawAgentId = agentJson?.results?.[0]?.agentId ?? agentJson?.agentId;
    if (agentJson && rawAgentId !== agentId) {
      issues.push(`${safeAgentId}.json does not match summary agent id ${agentId}.`);
    }
    for (const suffix of ["stdout.log", "stderr.log"]) {
      if (!fs.existsSync(`${resolvedReportDir}/${safeAgentId}.${suffix}`)) {
        issues.push(`${safeAgentId}.${suffix} is missing.`);
      }
    }
  }

  const summaryMdPath = `${resolvedReportDir}/summary.md`;
  if (!fs.existsSync(summaryMdPath)) {
    issues.push("summary.md is missing.");
  } else if (!fs.readFileSync(summaryMdPath, "utf8").includes("Agent Role Live Eval Report")) {
    issues.push("summary.md does not look like an agent role eval report.");
  }

  return {
    ok: issues.length === 0,
    reportDir: resolvedReportDir,
    issueCount: issues.length,
    agentsRequested: requested,
    resultCount: results.length,
    issues,
  };
}

export function prepareOllamaForLiveWorkflow({
  env = process.env,
  spawn = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const config = resolveLiveWorkflowConfig(env);
  writeGitHubEnv(env, "OPENCLAW_AGENT_ROLE_EVAL_RESOLVED_MODEL", config.model);

  if (!isOllamaModelRef(config.model)) {
    stdout.write("Live eval model is not an Ollama ref; skipping local Ollama bootstrap.\n");
    return 0;
  }
  if (!config.bootstrapOllama) {
    stdout.write("Local Ollama bootstrap disabled; expecting an external Ollama endpoint.\n");
    return 0;
  }

  run("docker", ["rm", "-f", OLLAMA_CONTAINER_NAME], { spawn, ignoreFailure: true });
  let status = run(
    "docker",
    [
      "run",
      "--pull=always",
      "-d",
      "--name",
      OLLAMA_CONTAINER_NAME,
      "-e",
      "OLLAMA_CONTEXT_LENGTH=1024",
      "-e",
      "OLLAMA_NUM_PARALLEL=1",
      "-p",
      "127.0.0.1:11434:11434",
      "ollama/ollama:latest",
    ],
    { spawn },
  );
  if (status !== 0) {
    return status;
  }

  for (let attempt = 1; attempt <= 60; attempt += 1) {
    status = run("curl", ["-fsS", "http://127.0.0.1:11434/api/version"], {
      spawn,
      stdio: "ignore",
      ignoreFailure: true,
    });
    if (status === 0) {
      break;
    }
    if (attempt === 60) {
      run("docker", ["logs", OLLAMA_CONTAINER_NAME], { spawn, ignoreFailure: true });
      stderr.write("Ollama did not become ready.\n");
      return 1;
    }
    run("sleep", ["2"], { spawn, ignoreFailure: true });
  }

  if (config.ollamaMinMemMb > 0) {
    let availableKb;
    try {
      availableKb = Number(
        capture(
          "docker",
          ["exec", OLLAMA_CONTAINER_NAME, "awk", "/MemAvailable:/ {print $2}", "/proc/meminfo"],
          { spawn },
        ).trim(),
      );
    } catch (error) {
      stderr.write(
        `${error instanceof Error ? error.message : String(error)}\nCould not read available memory from the Ollama container.\n`,
      );
      return 1;
    }
    if (!Number.isFinite(availableKb) || availableKb < 0) {
      stderr.write("Could not read available memory from the Ollama container.\n");
      return 1;
    }
    const availableMb = Math.floor(availableKb / 1024);
    if (availableMb < config.ollamaMinMemMb) {
      run("docker", ["stats", "--no-stream", OLLAMA_CONTAINER_NAME], {
        spawn,
        ignoreFailure: true,
      });
      stdout.write(
        `::error title=Ollama runner memory too low::${config.model} needs an Ollama runner with at least ${config.ollamaMinMemMb} MiB available; container reports ${availableMb} MiB. Increase runner/Testbox memory or set OPENCLAW_AGENT_ROLE_EVAL_OLLAMA_MIN_MEM_MB to a verified lower value.\n`,
      );
      return 1;
    }
  }

  return run(
    "docker",
    ["exec", OLLAMA_CONTAINER_NAME, "ollama", "pull", ollamaModelId(config.model)],
    {
      spawn,
    },
  );
}

export function runLiveWorkflowEvals({
  env = process.env,
  spawn = spawnSync,
  stdout = process.stdout,
} = {}) {
  const config = resolveRunLiveWorkflowConfig(env);
  const reportDir = maybeReportDir(env);
  const report = reportDir
    ? {
        ok: true,
        model: config.model,
        timeoutSeconds: config.timeoutSeconds,
        agentsRequested: config.agents,
        results: [],
        startedAt: new Date().toISOString(),
      }
    : undefined;

  for (const agentId of config.agents) {
    const args = [
      "agents:eval:live:self-contained",
      "--",
      "--agent",
      agentId,
      "--timeout",
      String(config.timeoutSeconds),
      "--model",
      config.model,
    ];
    if (reportDir) {
      args.push("--json");
    }
    const result = spawn(
      "pnpm",
      args,
      reportDir
        ? { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
        : { stdio: "inherit", encoding: "utf8" },
    );
    const status = result.status ?? (result.error ? 1 : 0);
    let entryOk = status === 0;
    if (reportDir) {
      const safeAgentId = sanitizeReportName(agentId);
      const parsed = parseLiveEvalJson(result.stdout);
      const liveResult = parsed?.results?.[0];
      const fallbackError =
        status !== 0 || !liveResult?.ok ? tailText(result.stderr || result.stdout) : undefined;
      const entry = {
        ok: status === 0 && Boolean(liveResult?.ok),
        agentId,
        status,
        provider: liveResult?.provider,
        model: liveResult?.model,
        durationMs: liveResult?.durationMs,
        issues: liveResult?.evaluation?.issues ?? [],
        error: result.error?.message ?? liveResult?.error ?? fallbackError,
      };
      entryOk = entry.ok;
      report.results.push(entry);
      report.ok = report.ok && entry.ok;
      fs.mkdirSync(reportDir, { recursive: true });
      fs.writeFileSync(
        `${reportDir}/${safeAgentId}.json`,
        `${JSON.stringify(parsed ?? entry, null, 2)}\n`,
        "utf8",
      );
      fs.writeFileSync(`${reportDir}/${safeAgentId}.stdout.log`, tailText(result.stdout), "utf8");
      fs.writeFileSync(`${reportDir}/${safeAgentId}.stderr.log`, tailText(result.stderr), "utf8");
      stdout.write(`${liveReportLine(entry)}\n`);
      if (!entry.ok && entry.error) {
        stdout.write(`  ${entry.error}\n`);
      }
    }
    if (!entryOk) {
      if (report) {
        report.completedAt = new Date().toISOString();
        writeLiveWorkflowReport(reportDir, report, env);
      }
      return status || 1;
    }
  }
  if (report) {
    report.completedAt = new Date().toISOString();
    writeLiveWorkflowReport(reportDir, report, env);
  }
  return 0;
}

export function stopOllamaForLiveWorkflow({ spawn = spawnSync } = {}) {
  run("docker", ["rm", "-f", OLLAMA_CONTAINER_NAME], { spawn, ignoreFailure: true });
  return 0;
}
