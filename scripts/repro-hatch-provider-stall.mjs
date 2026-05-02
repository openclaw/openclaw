#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const DEFAULT_MESSAGE = "Wake up, my friend!";
const DEFAULT_MODEL = "openai/gpt-5.5";
const DEFAULT_PROBE_OBSERVE_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_WALL_TIMEOUT_MS = 20_000;

function usage() {
  return `Usage: node scripts/repro-hatch-provider-stall.mjs [options]

Starts a loopback OpenAI-compatible server that stalls /v1/responses, then runs
the local TUI hatch path against it under a pty.

Options:
  --timeout-ms <ms>          Pass --timeout-ms to openclaw tui.
  --wall-timeout-ms <ms>     Observation window after /v1/responses starts.
  --startup-timeout-ms <ms>  Time allowed for TUI to reach /v1/responses.
  --expect <stall|timeout>   Expected behavior. Defaults to timeout with
                             --timeout-ms, otherwise stall.
  --expect-input <responsive|unresponsive>
                             Expected behavior for --probe-message.
  --model <provider/model>   Default model to write into isolated config.
  --message <text>           Initial TUI message.
  --probe-action <submit|ctrl-c-twice>
                             Keystroke probe action. Defaults to submit.
  --probe-after-ms <ms>      Send --probe-message after this many ms.
  --probe-message <text>     Message to type into the TUI and submit.
  --probe-observe-ms <ms>    Time to wait for the probe to start another run.
  --require-watchdog         Fail unless the TUI prints the streaming watchdog.
  --repo-root <path>         Checkout to run pnpm openclaw from.
  --keep-temp                Keep the isolated repro home/state directory.
  --help                     Show this help.
`;
}

function parsePositiveInt(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    expect: undefined,
    expectInput: undefined,
    keepTemp: false,
    message: DEFAULT_MESSAGE,
    model: DEFAULT_MODEL,
    probeAction: "submit",
    probeAfterMs: undefined,
    probeMessage: undefined,
    probeObserveMs: DEFAULT_PROBE_OBSERVE_MS,
    requireWatchdog: false,
    repoRoot: process.cwd(),
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    timeoutMs: undefined,
    wallTimeoutMs: DEFAULT_WALL_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--keep-temp") {
      options.keepTemp = true;
      continue;
    }
    if (arg === "--require-watchdog") {
      options.requireWatchdog = true;
      continue;
    }

    const next = argv[index + 1];
    if (next === undefined) {
      throw new Error(`${arg} requires a value`);
    }
    index += 1;

    if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(next, arg);
    } else if (arg === "--wall-timeout-ms") {
      options.wallTimeoutMs = parsePositiveInt(next, arg);
    } else if (arg === "--startup-timeout-ms") {
      options.startupTimeoutMs = parsePositiveInt(next, arg);
    } else if (arg === "--expect") {
      if (next !== "stall" && next !== "timeout") {
        throw new Error("--expect must be stall or timeout");
      }
      options.expect = next;
    } else if (arg === "--expect-input") {
      if (next !== "responsive" && next !== "unresponsive") {
        throw new Error("--expect-input must be responsive or unresponsive");
      }
      options.expectInput = next;
    } else if (arg === "--model") {
      options.model = next;
    } else if (arg === "--message") {
      options.message = next;
    } else if (arg === "--probe-action") {
      if (next !== "submit" && next !== "ctrl-c-twice") {
        throw new Error("--probe-action must be submit or ctrl-c-twice");
      }
      options.probeAction = next;
    } else if (arg === "--probe-after-ms") {
      options.probeAfterMs = parsePositiveInt(next, arg);
    } else if (arg === "--probe-message") {
      options.probeMessage = next;
    } else if (arg === "--probe-observe-ms") {
      options.probeObserveMs = parsePositiveInt(next, arg);
    } else if (arg === "--repo-root") {
      options.repoRoot = path.resolve(next);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    ...options,
    expect: options.expect ?? (options.timeoutMs ? "timeout" : "stall"),
    expectInput: options.expectInput ?? (options.probeMessage ? "responsive" : undefined),
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function withTimeout(promise, ms, label) {
  const timeout = sleep(ms).then(() => ({ timedOut: true, label }));
  return await Promise.race([promise, timeout]);
}

async function startStallServer() {
  const requests = [];
  const firstResponsesRequest = createDeferred();
  const secondResponsesRequest = createDeferred();
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const record = {
      method: req.method ?? "",
      url: req.url ?? "",
      startedAt: Date.now(),
      bodyBytes: 0,
      requestClosedAt: undefined,
      transportClosedAt: undefined,
    };
    requests.push(record);

    req.on("data", (chunk) => {
      record.bodyBytes += chunk.length;
    });
    req.on("close", () => {
      record.requestClosedAt = Date.now();
    });
    res.on("close", () => {
      record.transportClosedAt ??= Date.now();
    });
    req.socket.on("close", () => {
      record.transportClosedAt ??= Date.now();
    });

    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-5.5", object: "model" }] }));
      return;
    }

    if (req.method === "POST" && req.url === "/v1/responses") {
      req.resume();
      const responsesRequestCount = requests.filter(
        (item) => item.method === "POST" && item.url === "/v1/responses",
      ).length;
      if (responsesRequestCount === 1) {
        firstResponsesRequest.resolve(record);
      } else if (responsesRequestCount === 2) {
        secondResponsesRequest.resolve(record);
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: { message: `Unhandled ${req.method ?? ""} ${req.url ?? ""}` } }),
    );
  });

  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.timeout = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(0);
    socket.on("close", () => sockets.delete(socket));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("stall server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(resolve);
      }),
    firstResponsesRequest,
    requests,
    secondResponsesRequest,
  };
}

async function writeConfig(params) {
  const [provider, modelId] = params.model.split("/", 2);
  if (!provider || !modelId) {
    throw new Error(`Model must use provider/model form: ${params.model}`);
  }

  await fs.mkdir(path.dirname(params.configPath), { recursive: true });
  const config = {
    agents: {
      defaults: {
        model: { primary: params.model },
      },
    },
    models: {
      providers: {
        [provider]: {
          baseUrl: params.baseUrl,
          apiKey: "${OPENAI_API_KEY}",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: modelId,
              name: `Controlled stall ${modelId}`,
              api: "openai-responses",
              reasoning: true,
              input: ["text"],
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              contextWindow: 128_000,
              maxTokens: 8_192,
            },
          ],
        },
      },
    },
  };

  await fs.writeFile(params.configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeExpectWrapper(dir) {
  const wrapperPath = path.join(dir, "run-tui.expect");
  await fs.writeFile(
    wrapperPath,
    `#!/usr/bin/expect -f
log_user 1
if {[info exists env(OPENCLAW_REPRO_TUI_LOG)]} {
  log_file -noappend $env(OPENCLAW_REPRO_TUI_LOG)
}
set timeout -1
set commandArgs $argv
spawn -noecho {*}$commandArgs
set child [exp_pid]
if {[info exists env(OPENCLAW_REPRO_PROBE_AFTER_MS)] && [info exists env(OPENCLAW_REPRO_PROBE_MESSAGE)]} {
  after $env(OPENCLAW_REPRO_PROBE_AFTER_MS) {
    if {[info exists env(OPENCLAW_REPRO_PROBE_ACTION)] && $env(OPENCLAW_REPRO_PROBE_ACTION) eq "ctrl-c-twice"} {
      send -- "\\003"
      after 250 { send -- "\\003" }
    } else {
      send -- "$env(OPENCLAW_REPRO_PROBE_MESSAGE)"
      after 200 { send -- "\r" }
      after 400 { send -- "\n" }
    }
  }
}
trap {
  catch { exec kill -TERM $child }
  after 1000
  catch { exec kill -KILL $child }
  exit 143
} {SIGTERM SIGINT}
expect eof
catch wait result
exit 0
`,
  );
  await fs.chmod(wrapperPath, 0o700);
  return wrapperPath;
}

function spawnTui(params) {
  const args = ["pnpm", "openclaw", "tui", "--local", "--message", params.message];
  if (params.timeoutMs) {
    args.push("--timeout-ms", String(params.timeoutMs));
  }

  return spawn("expect", [params.wrapperPath, ...args], {
    cwd: params.repoRoot,
    env: {
      ...process.env,
      CI: "1",
      FORCE_COLOR: "0",
      HOME: params.homeDir,
      NO_COLOR: "1",
      OPENAI_API_KEY: "openclaw-controlled-stall-key",
      OPENCLAW_CONFIG_PATH: params.configPath,
      OPENCLAW_HOME: params.homeDir,
      ...(params.probeAfterMs && params.probeMessage
        ? {
            OPENCLAW_REPRO_PROBE_AFTER_MS: String(params.probeAfterMs),
            OPENCLAW_REPRO_PROBE_ACTION: params.probeAction,
            OPENCLAW_REPRO_PROBE_MESSAGE: params.probeMessage,
          }
        : {}),
      OPENCLAW_REPRO_TUI_LOG: params.tuiLogPath,
      OPENCLAW_STATE_DIR: params.stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function terminateProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), sleep(2_000)]);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hatch-stall-"));
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const tuiLogPath = path.join(root, "tui.log");
  const server = await startStallServer();
  let child;

  try {
    await fs.mkdir(stateDir, { recursive: true });
    await writeConfig({ baseUrl: server.baseUrl, configPath, model: options.model });
    const wrapperPath = await writeExpectWrapper(root);
    child = spawnTui({
      configPath,
      homeDir,
      message: options.message,
      probeAction: options.probeAction,
      probeAfterMs: options.probeAfterMs,
      probeMessage: options.probeMessage,
      stateDir,
      timeoutMs: options.timeoutMs,
      tuiLogPath,
      wrapperPath,
      repoRoot: options.repoRoot,
    });

    const stderrChunks = [];
    const stdoutChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    const childExitPromise = once(child, "exit").then(([exitCode, signal]) => ({
      exitCode,
      signal,
    }));

    const firstRequestResult = await withTimeout(
      server.firstResponsesRequest.promise,
      options.startupTimeoutMs,
      "startup",
    );
    if (firstRequestResult?.timedOut) {
      await terminateProcess(child);
      throw new Error(
        `TUI did not reach /v1/responses within ${options.startupTimeoutMs}ms. stderr:\n${Buffer.concat(stderrChunks).toString("utf8")}`,
      );
    }

    const request = firstRequestResult;
    const observedPromise = withTimeout(
      new Promise((resolve) => {
        const interval = setInterval(() => {
          if (request.transportClosedAt) {
            clearInterval(interval);
            resolve({ closed: true });
          }
        }, 100);
      }),
      options.wallTimeoutMs,
      "wall",
    );
    const probeObservationPromise =
      options.probeMessage && options.probeAfterMs
        ? withTimeout(
            options.probeAction === "ctrl-c-twice"
              ? childExitPromise
              : server.secondResponsesRequest.promise,
            options.probeAfterMs + options.probeObserveMs,
            "probe",
          )
        : undefined;
    const [observed, probeObservation] = await Promise.all([
      observedPromise,
      probeObservationPromise,
    ]);

    const closedBeforeWall = observed && !observed.timedOut;
    const probeActionCompleted = Boolean(probeObservation && !probeObservation.timedOut);
    const probeStartedSecondRun = options.probeAction === "submit" ? probeActionCompleted : false;
    const probeExitedTui = options.probeAction === "ctrl-c-twice" ? probeActionCompleted : false;
    const closeDelayMs = request.transportClosedAt
      ? request.transportClosedAt - request.startedAt
      : undefined;
    const expectedTimeoutUpperBound =
      options.timeoutMs === undefined ? undefined : options.timeoutMs + 5_000;
    const transportExpectationPassed =
      options.expect === "stall"
        ? !closedBeforeWall
        : closedBeforeWall &&
          closeDelayMs !== undefined &&
          (expectedTimeoutUpperBound === undefined || closeDelayMs <= expectedTimeoutUpperBound);
    let tuiLog = "";
    try {
      tuiLog = await fs.readFile(tuiLogPath, "utf8");
    } catch {
      tuiLog = "";
    }
    const normalizedTuiLog = `${Buffer.concat(stdoutChunks).toString("utf8")}\n${tuiLog}`
      .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
      .replace(/\r/g, "\n");
    const sawWakeMessage = normalizedTuiLog.includes(options.message);
    const sawWatchdog = normalizedTuiLog.includes("streaming watchdog: no stream updates");
    const sawIdle = /local ready\s*\|\s*idle/.test(normalizedTuiLog);
    const sawProbeMessage = options.probeMessage
      ? normalizedTuiLog.includes(options.probeMessage)
      : undefined;
    const inputExpectationPassed =
      !options.expectInput ||
      (options.expectInput === "responsive" ? probeActionCompleted : !probeActionCompleted);
    const watchdogExpectationPassed = !options.requireWatchdog || sawWatchdog;
    const passed =
      transportExpectationPassed && inputExpectationPassed && watchdogExpectationPassed;

    await terminateProcess(child);
    const responsesRequestCount = server.requests.filter(
      (item) => item.method === "POST" && item.url === "/v1/responses",
    ).length;

    const summary = {
      passed,
      expect: options.expect,
      expectInput: options.expectInput,
      model: options.model,
      probeAction: options.probeAction,
      probeAfterMs: options.probeAfterMs,
      probeExitedTui,
      probeMessage: options.probeMessage,
      probeStartedSecondRun,
      repoRoot: options.repoRoot,
      sawIdle,
      sawProbeMessage,
      sawWakeMessage,
      sawWatchdog,
      timeoutMs: options.timeoutMs,
      wallTimeoutMs: options.wallTimeoutMs,
      baseUrl: server.baseUrl,
      responsesRequestStarted: true,
      responsesRequestClosedBeforeWall: closedBeforeWall,
      responsesRequestCloseDelayMs: closeDelayMs,
      responsesRequestCount,
      requestCount: server.requests.length,
      tempRoot: options.keepTemp ? root : undefined,
    };
    console.log(JSON.stringify(summary, null, 2));

    if (!passed) {
      process.exitCode = 1;
    }
  } finally {
    if (child) {
      await terminateProcess(child);
    }
    await server.close();
    if (!options.keepTemp) {
      await fs.rm(root, { force: true, recursive: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
