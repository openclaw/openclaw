import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readPositiveIntEnv, readTcpPortEnv } from "../env-limits.mjs";
import {
  gatewayCall,
  readTranscriptRows,
  runCli,
  seedColdStorageFixture,
  waitForArchives,
} from "../session-cold-storage/fixture.mjs";

const [phase, entry, fixturePath] = process.argv.slice(2);
assert.ok(entry && fixturePath, "Expected seed|recall, installed CLI entry, and fixture path");
const context = {
  entry,
  env: process.env,
  url: `ws://127.0.0.1:${readTcpPortEnv("PORT", 18789)}`,
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
};
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert.ok(stateDir, "OPENCLAW_STATE_DIR is required");

if (phase === "seed") {
  const fixtures = await seedColdStorageFixture({
    stateDir,
    workspaceDir: process.env.OPENCLAW_TEST_WORKSPACE_DIR,
  });
  const fixture = fixtures.find((row) => row.label === "old");
  assert.ok(fixture, "The fixture must include an old transcript");
  await runCli(context, ["doctor", "--fix", "--yes", "--force"]);
  const rows = readTranscriptRows(stateDir, fixture.sessionId);
  assert.ok(rows.length > 0, "Doctor must import the historical transcript");
  await writeFile(fixturePath, JSON.stringify({ ...fixture, rows }));
} else if (phase === "recall") {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  // Do not read history before chat.send: that would restore it ahead of the model path.
  await waitForArchives(context, [fixture.sessionId]);
  // The HTTP case supplies get_weather externally; the agent recall uses no tools.
  const config = await gatewayCall(context, "config.get", {});
  const policy = await gatewayCall(context, "config.patch", {
    raw: JSON.stringify({ tools: { allow: [], deny: ["*"] } }),
    baseHash: config.hash,
    replacePaths: ["tools.allow"],
  });
  assert.equal(policy.restart, undefined);
  assert.equal(readTranscriptRows(stateDir, fixture.sessionId).length, 0);

  const message =
    "What recall code did I give you earlier? Reply with only that code. Do not use tools.";
  assert.ok(!message.includes(fixture.nonce));
  const timeoutMs = readPositiveIntEnv("OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS", 180) * 1000;
  const started = await gatewayCall(context, "chat.send", {
    sessionKey: fixture.sessionKey,
    message,
    idempotencyKey: randomUUID(),
    deliver: false,
  });
  assert.equal(started.status, "started");
  assert.equal(typeof started.runId, "string");
  const completed = await gatewayCall(
    context,
    "agent.wait",
    { runId: started.runId, timeoutMs },
    { timeoutMs: timeoutMs + 5000 },
  );
  assert.equal(completed.status, "ok", `Recall run ${started.runId} did not complete`);
  const history = await gatewayCall(context, "chat.history", {
    sessionKey: fixture.sessionKey,
    limit: 20,
  });
  const answer = history.messages?.findLast((row) => row.role === "assistant");
  const text =
    typeof answer?.content === "string"
      ? answer.content
      : (answer?.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  assert.equal(text.trim(), fixture.nonce, "The model must recall the code from cold history");
  const rows = readTranscriptRows(stateDir, fixture.sessionId);
  assert.deepEqual(rows.slice(0, fixture.rows.length), fixture.rows);
  assert.ok(
    rows.length > fixture.rows.length,
    "The completed turn must append to the restored transcript",
  );

  const listed = await gatewayCall(context, "sessions.list", {
    agentId: "main",
    archived: "all",
    limit: 20,
  });
  const session = listed.sessions?.find((row) => row.key === fixture.sessionKey);
  assert.ok(session, "The completed recall session must be listed");
  const modelRef = process.env.MODEL_REF;
  assert.ok(modelRef?.startsWith("openai/"));
  assert.equal(session.modelProvider, "openai");
  assert.equal(session.model, modelRef.slice("openai/".length));
  assert.ok(session.inputTokens > 0);
  assert.ok(session.outputTokens > 0);
  assert.ok(session.totalTokens > 0);
  console.log(
    JSON.stringify({
      ok: true,
      scenario: "cold-transcript-recall",
      runId: started.runId,
      provider: session.modelProvider,
      model: session.model,
      preservedEvents: fixture.rows.length,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
    }),
  );
} else {
  throw new Error(`Unknown cold transcript recall phase: ${phase}`);
}
