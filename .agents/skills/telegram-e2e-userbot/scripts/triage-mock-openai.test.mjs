import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { addAbortSignal } from "node:stream";
import nodeTest from "node:test";

const fixturePath = new URL("./triage-mock-openai.mjs", import.meta.url);
const test = (name, run) => nodeTest(name, { timeout: 60_000 }, run);

async function startFixture(context, scenario) {
  const server = spawn(process.execPath, [fixturePath.pathname], {
    env: { ...process.env, MOCK_PORT: "0", E2E_TRIAGE_SCENARIO: scenario },
    stdio: ["ignore", "pipe", "inherit"],
  });
  context.after(() => stopFixture(server));
  let output = "";
  server.stdout.setEncoding("utf8");
  addAbortSignal(context.signal, server.stdout);
  for await (const chunk of server.stdout.iterator({ destroyOnReturn: false })) {
    output += chunk;
    if (/mock-openai listening on \d+\n/u.test(output)) {
      break;
    }
  }
  assert.match(output, /mock-openai listening on \d+\n/u);
  const port = output.match(/mock-openai listening on (\d+)/u)[1];
  return async (body, pathname = "/v1/responses", status = 200) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: context.signal,
    });
    assert.equal(response.status, status);
    return response.text();
  };
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
  const text = await post({ model: "gpt-5.5", messages: [] }, "/v1/chat/completions");
  assert.match(text, /response\.output_text/u);
  assert.match(text, /reasoning\.text/u);
  assert.match(text, /PRIVATE_MONOLOGUE/u);
  assert.match(text, /PUBLIC_FINAL/u);
});

test("ends an empty assistant turn at tool use", async (context) => {
  const post = await startFixture(context, "incomplete-tool-use");
  const text = await post({ model: "gpt-5.5", messages: [] }, "/v1/chat/completions");
  assert.match(text, /"finish_reason":"tool_calls"/u);
  assert.doesNotMatch(text, /tool_calls":\[/u);
});

test("emits the recoverable double-wrapped Tool Search shape", async (context) => {
  const post = await startFixture(context, "tool-search-double-wrap");
  const text = await post({ model: "gpt-5.5", input: [] });
  assert.match(text, /"name":"dispatch_action"/u);
  assert.match(text, /\\"args\\":\{\\"id\\":\\"session_status\\"/u);
});

test("fails primary and succeeds fallback", async (context) => {
  const post = await startFixture(context, "model-fallback-room");
  assert.match(
    await post({ model: "primary", input: [] }, "/v1/responses", 503),
    /PRIMARY_ROUTE_UNAVAILABLE/u,
  );
  assert.match(await post({ model: "fallback", input: [] }), /FALLBACK_ROUTE_OK/u);
});

test("spawns before yielding with a user-facing message", async (context) => {
  const post = await startFixture(context, "yield-message-drop");
  const spawned = await post({ tools: [{ name: "sessions_yield" }], input: [] });
  assert.match(spawned, /"name":"sessions_spawn"/u);
  const yielded = await post({
    tools: [{ name: "sessions_yield" }],
    input: [{ type: "function_call_output", output: "accepted" }],
  });
  assert.match(yielded, /"name":"sessions_yield"/u);
  assert.match(yielded, /RESEARCH_STARTED_107788/u);
});

test("pauses after three preview deltas before the final stream value", async (context) => {
  const post = await startFixture(context, "streaming-throttle");
  const startedAt = Date.now();
  const text = await post({ input: [] });
  assert.ok(Date.now() - startedAt >= 1_400);
  assert.equal(text.match(/response\.output_text\.delta/gu)?.length, 3);
  assert.match(text, /STREAM_FINAL_107179/u);
});

test("emits a good draft and tool before terminal NO_REPLY", async (context) => {
  const post = await startFixture(context, "terminal-no-reply-drops-draft");
  const draft = await post({ input: [] });
  assert.match(draft, /GOOD_DRAFT_115041/u);
  assert.match(draft, /"name":"exec"/u);
  const terminal = await post({ input: [{ type: "function_call_output", output: "tool-ok" }] });
  assert.match(terminal, /NO_REPLY/u);
});
