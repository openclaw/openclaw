import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import nodeTest from "node:test";

const fixturePath = new URL("./triage-mock-openai.mjs", import.meta.url);
// Bounds a stalled fixture. Each case takes about 150 ms on a loaded host.
const TEST_TIMEOUT_MS = 60_000;
const test = (name, run) => nodeTest(name, { timeout: TEST_TIMEOUT_MS }, run);

function withinTest(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function startFixture(context, scenario) {
  const server = spawn(process.execPath, [fixturePath.pathname], {
    env: { ...process.env, MOCK_PORT: "0", E2E_TRIAGE_SCENARIO: scenario },
    stdio: ["ignore", "pipe", "inherit"],
  });
  context.after(() => stopFixture(server));
  let output = "";
  server.stdout.setEncoding("utf8");
  // The banner is the readiness signal; closed output means it can never arrive.
  const settled = new Promise((resolve) => {
    server.stdout.on("data", (chunk) => {
      output += chunk;
      if (/mock-openai listening on \d+\n/u.test(output)) {
        resolve();
      }
    });
    server.stdout.once("close", resolve);
  });
  await withinTest(settled, context.signal);
  assert.match(output, /mock-openai listening on \d+\n/u);
  const port = output.match(/mock-openai listening on (\d+)/u)[1];
  return (body, pathname = "/v1/responses") =>
    fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: context.signal,
    });
}

async function stopFixture(server) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  await exited;
}

test("emits interleaved visible and reasoning blocks", async (context) => {
  const post = await startFixture(context, "interleaved-monologue");
  const response = await post({ model: "gpt-5.5", messages: [] }, "/v1/chat/completions");
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /response\.output_text/u);
  assert.match(text, /reasoning\.text/u);
  assert.match(text, /PRIVATE_MONOLOGUE/u);
  assert.match(text, /PUBLIC_FINAL/u);
});

test("ends an empty assistant turn at tool use", async (context) => {
  const post = await startFixture(context, "incomplete-tool-use");
  const response = await post({ model: "gpt-5.5", messages: [] }, "/v1/chat/completions");
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /"finish_reason":"tool_calls"/u);
  assert.doesNotMatch(text, /tool_calls":\[/u);
});

test("emits the recoverable double-wrapped Tool Search shape", async (context) => {
  const post = await startFixture(context, "tool-search-double-wrap");
  const response = await post({ model: "gpt-5.5", input: [] });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /"name":"dispatch_action"/u);
  assert.match(text, /\\"args\\":\{\\"id\\":\\"session_status\\"/u);
});

test("fails primary and succeeds fallback", async (context) => {
  const post = await startFixture(context, "model-fallback-room");
  const primary = await post({ model: "primary", input: [] });
  assert.equal(primary.status, 503);
  assert.match(await primary.text(), /PRIMARY_ROUTE_UNAVAILABLE/u);
  const fallback = await post({ model: "fallback", input: [] });
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /FALLBACK_ROUTE_OK/u);
});

test("spawns before yielding with a user-facing message", async (context) => {
  const post = await startFixture(context, "yield-message-drop");
  const spawned = await post({ tools: [{ name: "sessions_yield" }], input: [] });
  assert.match(await spawned.text(), /"name":"sessions_spawn"/u);
  const yielded = await post({
    tools: [{ name: "sessions_yield" }],
    input: [{ type: "function_call_output", output: "accepted" }],
  });
  const text = await yielded.text();
  assert.match(text, /"name":"sessions_yield"/u);
  assert.match(text, /RESEARCH_STARTED_107788/u);
});

test("pauses after three preview deltas before the final stream value", async (context) => {
  const post = await startFixture(context, "streaming-throttle");
  const startedAt = Date.now();
  const response = await post({ input: [] });
  const text = await response.text();
  assert.ok(Date.now() - startedAt >= 1_400);
  assert.equal(text.match(/response\.output_text\.delta/gu)?.length, 3);
  assert.match(text, /STREAM_FINAL_107179/u);
});

test("emits a good draft and tool before terminal NO_REPLY", async (context) => {
  const post = await startFixture(context, "terminal-no-reply-drops-draft");
  const draft = await post({ input: [] });
  const draftText = await draft.text();
  assert.match(draftText, /GOOD_DRAFT_115041/u);
  assert.match(draftText, /"name":"exec"/u);
  const terminal = await post({ input: [{ type: "function_call_output", output: "tool-ok" }] });
  assert.match(await terminal.text(), /NO_REPLY/u);
});
