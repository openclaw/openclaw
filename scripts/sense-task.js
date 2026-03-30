#!/usr/bin/env node
import process from "node:process";

const DEFAULT_BASE_URL = process.env.SENSE_WORKER_URL?.trim() || "http://192.168.11.11:8787";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_ENV = "SENSE_WORKER_TOKEN";

function parseArgs(argv) {
  const options = {
    _: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return options;
}

function resolveToken(options) {
  if (typeof options.token === "string" && options.token.trim()) {
    return options.token.trim();
  }
  const envName =
    typeof options["token-env"] === "string" && options["token-env"].trim()
      ? options["token-env"].trim()
      : DEFAULT_TOKEN_ENV;
  const envValue = process.env[envName];
  return typeof envValue === "string" && envValue.trim() ? envValue.trim() : undefined;
}

function normalizeStructured(resultBody) {
  if (!resultBody || typeof resultBody !== "object") {
    return undefined;
  }
  const result = resultBody.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  if (
    typeof result.summary === "string" &&
    Array.isArray(result.key_points) &&
    typeof result.suggested_next_action === "string"
  ) {
    return {
      summary: result.summary,
      key_points: result.key_points.filter((v) => typeof v === "string"),
      suggested_next_action: result.suggested_next_action,
    };
  }
  const details = result.details;
  if (details && typeof details === "object" && details.structured && typeof details.structured === "object") {
    const structured = details.structured;
    return {
      summary: typeof structured.summary === "string" ? structured.summary : "",
      key_points: Array.isArray(structured.key_points) ? structured.key_points.filter((v) => typeof v === "string") : [],
      suggested_next_action:
        typeof structured.suggested_next_action === "string" ? structured.suggested_next_action : "",
      worker_state: typeof details.worker_state === "string" ? details.worker_state : undefined,
      structured_source: typeof details.structured_source === "string" ? details.structured_source : undefined,
    };
  }
  if (result.mode === "long_text_review" && details && typeof details === "object") {
    return {
      summary: typeof details.review_summary === "string" ? details.review_summary : "",
      key_points: Array.isArray(details.review_points) ? details.review_points.filter((v) => typeof v === "string") : [],
      suggested_next_action:
        typeof details.recommended_next_step === "string" ? details.recommended_next_step : "",
      worker_state: typeof details.worker_state === "string" ? details.worker_state : undefined,
      structured_source: typeof details.structured_source === "string" ? details.structured_source : undefined,
    };
  }
  return undefined;
}

function normalizeJob(resultBody) {
  if (!resultBody || typeof resultBody !== "object") {
    return undefined;
  }
  if (typeof resultBody.status === "string" && resultBody.result && typeof resultBody.result === "object") {
    const result = resultBody.result;
    if (typeof result.job_id === "string") {
      return {
        job_id: result.job_id,
        status:
          typeof result.status === "string"
            ? result.status
            : typeof resultBody.status === "string"
              ? resultBody.status
              : undefined,
        stage: typeof result.stage === "string" ? result.stage : undefined,
        target: typeof result.target === "string" ? result.target : undefined,
        message: typeof result.message === "string" ? result.message : undefined,
      };
    }
  }
  if (resultBody.error === "job_not_found") {
    return {
      job_id: typeof resultBody.job_id === "string" ? resultBody.job_id : undefined,
      status: "job_not_found",
    };
  }
  return undefined;
}

async function requestJson({ method, url, token, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: "application/json" };
    if (token) headers["X-Sense-Worker-Token"] = token;
    if (body) headers["Content-Type"] = "application/json";
    const init = {
      method,
      headers,
      signal: controller.signal,
    };
    if (body && method !== "GET") {
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const raw = await response.text();
    let parsed = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {}
    const result = {
      ok: response.ok,
      status: response.status,
      url,
      body: parsed,
    };
    const job = normalizeJob(parsed);
    if (job) {
      result.job = job;
    }
    const normalized = normalizeStructured(parsed);
    if (normalized) {
      result.normalized = normalized;
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readInput(options) {
  if (typeof options.input === "string") {
    return options.input;
  }
  if (options._.length > 1) {
    return options._.slice(1).join(" ");
  }
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return "";
}

async function submitTask(command, options) {
  const baseUrl = (typeof options["base-url"] === "string" ? options["base-url"] : DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs =
    typeof options.timeout === "string" && Number.isFinite(Number(options.timeout))
      ? Number(options.timeout)
      : DEFAULT_TIMEOUT_MS;
  const token = resolveToken(options);
  const input = await readInput(options);
  let params = {};
  if (typeof options["params-json"] === "string" && options["params-json"].trim()) {
    params = JSON.parse(options["params-json"]);
  }
  if (command === "heavy_task" && typeof options.mode === "string" && options.mode.trim()) {
    params = { ...params, mode: options.mode.trim() };
  }
  const payload = {
    task: command,
    input,
    params,
  };
  const result = await requestJson({
    method: "POST",
    url: `${baseUrl}/execute`,
    token,
    body: payload,
    timeoutMs,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

async function jobStatus(options, poll = false) {
  const jobId =
    (typeof options["job-id"] === "string" && options["job-id"].trim()) ||
    (typeof options._[1] === "string" && options._[1].trim());
  if (!jobId) {
    throw new Error("job id required");
  }
  const baseUrl = (typeof options["base-url"] === "string" ? options["base-url"] : DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs =
    typeof options.timeout === "string" && Number.isFinite(Number(options.timeout))
      ? Number(options.timeout)
      : DEFAULT_TIMEOUT_MS;
  const intervalMs =
    typeof options["interval-ms"] === "string" && Number.isFinite(Number(options["interval-ms"]))
      ? Number(options["interval-ms"])
      : 1000;
  const maxPolls =
    typeof options["max-polls"] === "string" && Number.isFinite(Number(options["max-polls"]))
      ? Number(options["max-polls"])
      : 30;

  let attempts = 0;
  while (true) {
    attempts += 1;
    const result = await requestJson({
      method: "GET",
      url: `${baseUrl}/jobs/${jobId}`,
      timeoutMs,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!poll) {
      process.exit(result.ok ? 0 : 1);
    }
    const status = result.body && typeof result.body === "object" ? result.body.status : undefined;
    if (!result.ok || status === "done" || status === "job_not_found" || attempts >= maxPolls) {
      process.exit(result.ok ? 0 : 1);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0];
  if (!command) {
    throw new Error("command required");
  }
  if (command === "job-status") {
    await jobStatus(options, false);
    return;
  }
  if (command === "job-poll") {
    await jobStatus(options, true);
    return;
  }
  await submitTask(command, options);
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
