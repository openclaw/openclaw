import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const fixturePath = new URL("./triage-mock-openai.mjs", import.meta.url);

async function startFixture(context, scenario) {
  const server = spawn(process.execPath, [fixturePath.pathname], {
    env: { ...process.env, MOCK_PORT: "19993", E2E_TRIAGE_SCENARIO: scenario },
    stdio: ["ignore", "pipe", "inherit"],
  });
  context.after(() => stopFixture(server));
  let output = "";
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    output += chunk;
  });
  for (let attempt = 0; attempt < 100 && !output.includes("mock-openai listening"); attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.match(output, /mock-openai listening/u);
}

async function stopFixture(server) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  await exited;
}

async function post(body, pathname = "/v1/responses") {
  return fetch(`http://127.0.0.1:19993${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("emits interleaved visible and reasoning blocks", async (context) => {
  await startFixture(context, "interleaved-monologue");
  const response = await post({ model: "gpt-5.5", messages: [] }, "/v1/chat/completions");
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /response\.output_text/u);
  assert.match(text, /reasoning\.text/u);
  assert.match(text, /PRIVATE_MONOLOGUE/u);
  assert.match(text, /PUBLIC_FINAL/u);
});

test("ends an empty assistant turn at tool use", async (context) => {
  await startFixture(context, "incomplete-tool-use");
  const response = await post({ model: "gpt-5.5", messages: [] }, "/v1/chat/completions");
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /"finish_reason":"tool_calls"/u);
  assert.doesNotMatch(text, /tool_calls":\[/u);
});

test("emits the recoverable double-wrapped Tool Search shape", async (context) => {
  await startFixture(context, "tool-search-double-wrap");
  const response = await post({ model: "gpt-5.5", input: [] });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /"name":"tool_call"/u);
  assert.match(text, /\\"args\\":\{\\"id\\":\\"session_status\\"/u);
});

test("fails primary and succeeds fallback", async (context) => {
  await startFixture(context, "model-fallback-room");
  const primary = await post({ model: "primary", input: [] });
  assert.equal(primary.status, 503);
  assert.match(await primary.text(), /PRIMARY_ROUTE_UNAVAILABLE/u);
  const fallback = await post({ model: "fallback", input: [] });
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /FALLBACK_ROUTE_OK/u);
});

test("spawns before yielding with a user-facing message", async (context) => {
  await startFixture(context, "yield-message-drop");
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
  await startFixture(context, "streaming-throttle");
  const startedAt = Date.now();
  const response = await post({ input: [] });
  const text = await response.text();
  assert.ok(Date.now() - startedAt >= 1_400);
  assert.equal(text.match(/response\.output_text\.delta/gu)?.length, 3);
  assert.match(text, /STREAM_FINAL_107179/u);
});

test("emits a good draft and tool before terminal NO_REPLY", async (context) => {
  await startFixture(context, "terminal-no-reply-drops-draft");
  const draft = await post({ input: [] });
  const draftText = await draft.text();
  assert.match(draftText, /GOOD_DRAFT_115041/u);
  assert.match(draftText, /"name":"exec"/u);
  const terminal = await post({ input: [{ type: "function_call_output", output: "tool-ok" }] });
  assert.match(await terminal.text(), /NO_REPLY/u);
});
