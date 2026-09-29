// Run with: node --import ./scripts/tsx.mjs scripts/dev/tui-questions-proof.ts --output <directory>
// Exercises real source TUI backends with isolated state and a scripted loopback model.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { QuestionWaitAnswerResult } from "../../packages/gateway-protocol/src/schema/questions.js";
import { iterateAnsiSegments } from "../../packages/terminal-core/src/ansi-sequences.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  PtyTestScreen,
  startPty,
  waitFor,
  type PtyRun,
} from "../../src/tui/tui-pty-test-support.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const self = fileURLToPath(import.meta.url);
const loader = path.join(root, "scripts/tsx.mjs");
const sessionKey = "agent:main:main";
const questionText = "Which color should this synthetic proof use?";
const choices = [{ label: "Blue" }, { label: "Green" }];

async function childMain(mode: string, args: string[]) {
  if (mode === "--tui-child") {
    const { Command } = await import("commander");
    const { registerTuiCli } = await import("../../src/cli/tui-cli.js");
    const program = new Command();
    registerTuiCli(program);
    await program.parseAsync([process.execPath, "openclaw", "tui", ...args]);
    return;
  }
  if (mode === "--gateway-child") {
    const { startGatewayServer } = await import("../../src/gateway/server.js");
    const server = await startGatewayServer(Number(args[0]), {
      bind: "loopback",
      controlUiEnabled: false,
    });
    await server.startupSettled;
    process.stdout.write("QUESTION_PROOF_GATEWAY_READY\n");
    let closing = false;
    const close = async () => {
      if (closing) {
        return;
      }
      closing = true;
      await server.close({ reason: "question proof complete" });
      process.exit(0);
    };
    process.once("SIGTERM", () => void close());
    process.once("SIGINT", () => void close());
    return;
  }
  if (mode === "--rpc-child") {
    const { callGateway } = await import("../../src/gateway/call.js");
    const config: OpenClawConfig = JSON.parse(
      await readFile(process.env.OPENCLAW_CONFIG_PATH!, "utf8"),
    );
    const result = await callGateway({
      url: `ws://127.0.0.1:${config.gateway?.port}`,
      token: process.env.OPENCLAW_GATEWAY_TOKEN,
      config,
      method: args[0]!,
      params: JSON.parse(args[1] ?? "{}"),
      scopes: ["operator.admin"],
      timeoutMs: 30_000,
    });
    process.stdout.write(`QUESTION_PROOF_RPC=${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(`Unknown proof child mode: ${mode}`);
}

function startChild(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: "pipe" });
  let output = "";
  let exited = false;
  let failure: Error | undefined;
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.on("error", (error) => (failure = error));
  child.on("exit", () => (exited = true));
  const wait = async (needle: string) =>
    await waitFor({
      timeoutMs: 60_000,
      read: () => {
        if (failure) {
          throw failure;
        }
        if (output.includes(needle)) {
          return output;
        }
        if (exited) {
          throw new Error(`Proof child exited before ${needle}\n${output}`);
        }
        return null;
      },
      onTimeout: () => new Error(`Proof child did not emit ${needle}\n${output}`),
    });
  return { child, output: () => output, wait };
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(25);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
  }
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function frame(run: PtyRun) {
  const screen = new PtyTestScreen(run);
  let complete = "";
  for (const segment of iterateAnsiSegments(run.output())) {
    if (segment.kind === "text") {
      screen.write(segment.value, true);
    } else if (segment.value === "\x1b[?2026l") {
      complete = screen.cells
        .map((row) =>
          row
            .map((cell) => cell.text)
            .join("")
            .trimEnd(),
        )
        .join("\n");
    } else if (segment.value.startsWith("\x1b[")) {
      screen.applyCsi(segment.value, true);
    }
  }
  return complete.trimEnd();
}

function hasAnswer(value: unknown, answer: string): boolean {
  if (typeof value === "string") {
    // ask_user's textResult contains its human-readable summary before the JSON payload.
    const payloadStart = value.indexOf("\n\n{");
    const candidate = payloadStart >= 0 ? value.slice(payloadStart + 2) : value;
    try {
      return hasAnswer(JSON.parse(candidate), answer);
    } catch {
      return false;
    }
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value).some(([key, nested]) =>
    key === "color" && Array.isArray(nested)
      ? nested.length === 1 && nested[0] === answer
      : hasAnswer(nested, answer),
  );
}

function modelQuestionEvents(callId: string, question = questionText) {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name: "ask_user",
    arguments: JSON.stringify({
      questions: [{ id: "color", header: "Color", question, options: choices }],
      timeoutSeconds: 120,
    }),
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${callId}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 32, output_tokens: 16, total_tokens: 48 },
      },
    },
  ];
}

async function runProof(outputDir: string) {
  const scratch = await mkdtemp(path.join(tmpdir(), "openclaw-question-proof-state-"));
  const requestLog = path.join(scratch, "model-requests.jsonl");
  const token = randomUUID();
  const redact = (value: string) => value.replaceAll(token, "[isolated Gateway token]");
  const describeFailure = (error: unknown) =>
    redact(error instanceof Error ? (error.stack ?? error.message) : String(error));
  const failures: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const terminals: PtyRun[] = [];
  const report: string[] = [];
  const cleanEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.keys(process.env).map((key) => [key, undefined]),
  );
  Object.assign(cleanEnv, {
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    OPENCLAW_THEME: "dark",
    OPENCLAW_CODEX_DISCOVERY_LIVE: "0",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_TUI_PTY_COLS: "100",
    OPENCLAW_TUI_PTY_ROWS: "32",
  });
  const launch = (args: string[], env: NodeJS.ProcessEnv) => {
    const child = startChild(args, env);
    children.push(child.child);
    return child;
  };
  const capture = async (name: string, run: PtyRun) => {
    const text = redact(frame(run));
    assert(text, `No completed terminal frame for ${name}`);
    await writeFile(path.join(outputDir, `${name}.txt`), `${text}\n`);
    report.push(`--- ${name} ---\n${text}`);
  };
  const terminalDiagnostic = (run: PtyRun) =>
    frame(run) || run.visibleOutput().slice(-16_000) || "No terminal output received.";
  const waitForText = async (run: PtyRun, needle: string) => {
    const deadline = Date.now() + 60_000;
    try {
      await run.waitForOutput(needle);
      await waitFor({
        timeoutMs: Math.max(1, deadline - Date.now()),
        read: () => (frame(run).includes(needle) ? true : null),
        onTimeout: () => new Error(`Terminal frame did not show ${needle}`),
      });
    } catch {
      throw new Error(`Terminal did not show ${needle}\n${terminalDiagnostic(run)}`);
    }
  };
  const startTui = async (env: NodeJS.ProcessEnv, args: string[], ready: string) => {
    const run = startPty(process.execPath, ["--import", loader, self, "--tui-child", ...args], {
      cwd: root,
      env,
      exitTimeoutMs: 5_000,
      outputTimeoutMs: 60_000,
    });
    terminals.push(run);
    await waitForText(run, ready);
    return run;
  };
  const waitForPrompt = async (run: PtyRun, question: string) =>
    await waitFor({
      timeoutMs: 60_000,
      read: () => {
        const text = frame(run);
        return text.includes(question) && text.includes("Enter confirm") ? true : null;
      },
      onTimeout: () => new Error(`Question prompt did not open\n${terminalDiagnostic(run)}`),
    });
  try {
    await mkdir(outputDir, { recursive: true });
    const mockPort = await freePort();
    const gatewayPort = await freePort();
    const controlPath = path.join(scratch, "responses.json");
    await writeFile(
      controlPath,
      JSON.stringify({
        responses: [
          { events: modelQuestionEvents("question_one") },
          { text: "LOCAL_QUESTION_ANSWER_RECEIVED" },
          {
            events: modelQuestionEvents(
              "question_two",
              "Which color should the typed reply choose?",
            ),
          },
          { text: "LOCAL_TYPED_ANSWER_RECEIVED" },
        ],
      }),
    );
    const mock = launch([path.join(root, "scripts/e2e/mock-openai-server.mjs")], {
      ...cleanEnv,
      MOCK_PORT: String(mockPort),
      MOCK_RESPONSE_CONTROL: controlPath,
      MOCK_REQUEST_LOG: requestLog,
    });
    await mock.wait("mock-openai listening on");

    const modeEnv = async (mode: string) => {
      const modeDir = path.join(scratch, mode);
      await mkdir(path.join(modeDir, "workspace"), { recursive: true });
      await mkdir(path.join(modeDir, "home"), { recursive: true });
      const config: OpenClawConfig = {
        gateway: { mode: "local", port: gatewayPort, auth: { mode: "token", token } },
        discovery: { mdns: { mode: "off" } },
        plugins: { enabled: false, slots: { memory: "none" } },
        agents: {
          defaults: {
            workspace: path.join(modeDir, "workspace"),
            skipBootstrap: true,
            skills: [],
            model: { primary: "question-proof/gpt-5.6-luna" },
            models: {
              "question-proof/gpt-5.6-luna": {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
          entries: { main: { skills: [] } },
        },
        models: {
          mode: "replace",
          providers: {
            "question-proof": {
              baseUrl: `http://127.0.0.1:${mockPort}/v1`,
              apiKey: "synthetic-proof-key",
              api: "openai-responses",
              request: { allowPrivateNetwork: true },
              models: [
                {
                  id: "gpt-5.6-luna",
                  name: "Synthetic question proof",
                  api: "openai-responses",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      };
      const configPath = path.join(modeDir, "openclaw.json");
      await writeFile(configPath, JSON.stringify(config));
      return {
        ...cleanEnv,
        HOME: path.join(modeDir, "home"),
        OPENCLAW_HOME: path.join(modeDir, "home"),
        OPENCLAW_STATE_DIR: path.join(modeDir, "state"),
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: token,
        XDG_CONFIG_HOME: path.join(modeDir, "xdg-config"),
        XDG_CACHE_HOME: path.join(modeDir, "xdg-cache"),
        XDG_DATA_HOME: path.join(modeDir, "xdg-data"),
      };
    };

    const gatewayEnv = await modeEnv("gateway");
    const gateway = launch(
      ["--import", loader, self, "--gateway-child", String(gatewayPort)],
      gatewayEnv,
    );
    await gateway.wait("QUESTION_PROOF_GATEWAY_READY");
    const rpc = async (method: string, params: unknown): Promise<unknown> => {
      const child = launch(
        ["--import", loader, self, "--rpc-child", method, JSON.stringify(params)],
        gatewayEnv,
      );
      const output = await child.wait("QUESTION_PROOF_RPC=");
      const line = output.split("\n").find((value) => value.startsWith("QUESTION_PROOF_RPC="));
      assert(line);
      return JSON.parse(line.slice("QUESTION_PROOF_RPC=".length));
    };
    const gatewayTui = await startTui(
      gatewayEnv,
      ["--url", `ws://127.0.0.1:${gatewayPort}`, "--token", token, "--session", sessionKey],
      "gateway connected",
    );
    await capture("gateway-before", gatewayTui);
    await rpc("question.request", {
      id: "tui-gateway-proof",
      sessionKey,
      agentId: "main",
      questions: [
        {
          questionId: "color",
          header: "Color",
          question: questionText,
          options: choices,
          isOther: true,
        },
      ],
      timeoutMs: 120_000,
    });
    await waitForPrompt(gatewayTui, questionText);
    await capture("gateway-question", gatewayTui);
    await gatewayTui.write("\r");
    const result = await rpc("question.waitAnswer", { id: "tui-gateway-proof", timeoutMs: 5_000 });
    const expected: QuestionWaitAnswerResult = {
      status: "answered",
      answers: { answers: { color: ["Blue"] } },
    };
    assert.deepEqual(result, expected);
    await waitForText(gatewayTui, "Question: answered.");
    await capture("gateway-after", gatewayTui);
    report.push(
      `Gateway question.request -> TUI -> question.waitAnswer: ${JSON.stringify(result)}`,
    );
    process.stdout.write("PASS: Gateway question.request -> TUI selection -> answered.\n");
    await gatewayTui.dispose();
    await stopChild(gateway.child);

    const localEnv = await modeEnv("local");
    const localTui = await startTui(localEnv, ["--local", "--session", sessionKey], "local ready");
    await capture("local-before", localTui);
    await localTui.write("Run the synthetic question proof.\r");
    await waitForPrompt(localTui, questionText);
    await capture("local-question", localTui);
    await localTui.write("\r");
    await waitForText(localTui, "LOCAL_QUESTION_ANSWER_RECEIVED");
    await capture("local-after", localTui);
    process.stdout.write("PASS: Local model ask_user -> TUI selection -> model completion.\n");
    await localTui.write("Ask the second synthetic question.\r");
    await waitForPrompt(localTui, "Which color should the typed reply choose?");
    await localTui.write("\x1b");
    await waitFor({
      timeoutMs: 60_000,
      read: () => {
        const text = frame(localTui);
        return text.includes("Question pending") && !text.includes("Enter confirm") ? true : null;
      },
      onTimeout: () =>
        new Error(`Esc did not restore the composer\n${terminalDiagnostic(localTui)}`),
    });
    await capture("local-collapsed", localTui);
    await localTui.write("Green\r");
    await waitForText(localTui, "LOCAL_TYPED_ANSWER_RECEIVED");
    await capture("local-typed-after", localTui);
    const requests: unknown[] = (await readFile(requestLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(hasAnswer(requests, "Blue"), "Model did not receive the selected answer");
    assert(hasAnswer(requests, "Green"), "Model did not receive the typed answer");
    report.push("Local model ask_user -> TUI selection -> model: Blue (verified request body)");
    report.push(
      "Local model ask_user -> Esc -> ordinary composer reply -> model: Green (verified request body)",
    );
    report.push(
      "PASS: Gateway and local question round trips; no real credentials or live state used.",
    );
    await writeFile(path.join(outputDir, "proof.txt"), `${report.join("\n\n")}\n`);
  } catch (error) {
    failures.push(describeFailure(error));
    try {
      await mkdir(outputDir, { recursive: true });
      for (const [index, terminal] of terminals.entries()) {
        await writeFile(
          path.join(outputDir, `failure-terminal-${index + 1}.txt`),
          `${redact(terminalDiagnostic(terminal))}\n`,
        );
      }
    } catch (captureError) {
      failures.push(`Could not preserve terminal evidence: ${describeFailure(captureError)}`);
    }
  } finally {
    // Keep only answer witnesses and call counts; mock requests contain full system prompts.
    try {
      const requestText = await readFile(requestLog, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return "";
        }
        throw error;
      });
      const entries: unknown[] = requestText
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      await writeFile(
        path.join(outputDir, "model-answer-evidence.json"),
        `${JSON.stringify(
          {
            requestCount: entries.length,
            requests: entries.map((entry, index) => ({
              index,
              containsBlueAnswer: hasAnswer(entry, "Blue"),
              containsGreenAnswer: hasAnswer(entry, "Green"),
            })),
          },
          null,
          2,
        )}\n`,
      );
    } catch (evidenceError) {
      failures.push(`Could not preserve mock answer evidence: ${describeFailure(evidenceError)}`);
    }
    const terminalCleanup = await Promise.allSettled(terminals.map((run) => run.dispose()));
    const childCleanup = await Promise.allSettled(children.map((child) => stopChild(child)));
    const cleanupFailures = [...terminalCleanup, ...childCleanup].flatMap((result) =>
      result.status === "rejected" ? [describeFailure(result.reason)] : [],
    );
    if (cleanupFailures.length > 0) {
      failures.push(
        `Proof cleanup failed; isolated state retained at ${scratch}`,
        ...cleanupFailures,
      );
    } else {
      try {
        await rm(scratch, { recursive: true, force: true });
      } catch (stateCleanupError) {
        failures.push(
          `Could not remove isolated state at ${scratch}: ${describeFailure(stateCleanupError)}`,
        );
      }
    }
  }
  if (failures.length > 0) {
    const diagnostic = `${failures.join("\n\n")}\n`;
    process.stderr.write(diagnostic);
    process.exitCode = 1;
    try {
      await mkdir(outputDir, { recursive: true });
      await writeFile(path.join(outputDir, "failure.txt"), diagnostic);
    } catch (reportError) {
      process.stderr.write(`Could not write failure report: ${describeFailure(reportError)}\n`);
    }
  } else {
    process.stdout.write(`${report.slice(-4).join("\n")}\nEvidence: ${outputDir}\n`);
  }
}

const args = process.argv.slice(2);
if (args[0]?.endsWith("-child")) {
  await childMain(args[0], args.slice(1));
} else if (args.includes("--help")) {
  process.stdout.write(
    "Usage: node --import ./scripts/tsx.mjs scripts/dev/tui-questions-proof.ts [--output <directory>]\n",
  );
} else {
  assert(
    args.length === 0 || (args.length === 2 && args[0] === "--output" && args[1]),
    "Expected --output <directory>",
  );
  const output = args[1]
    ? path.resolve(args[1])
    : await mkdtemp(path.join(tmpdir(), "openclaw-question-proof-evidence-"));
  await runProof(output);
}
