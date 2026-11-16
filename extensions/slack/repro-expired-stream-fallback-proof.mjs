import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoPath = path.resolve(process.argv[2] ?? process.cwd());
const repoSha = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const requireFromSlack = createRequire(path.join(repoPath, "extensions/slack/package.json"));
const { WebClient } = requireFromSlack("@slack/web-api");
const { createSlackStreamingDeliveryRuntime } = await import(
  pathToFileURL(
    path.join(repoPath, "extensions/slack/src/monitor/message-handler/dispatch-streaming.ts"),
  ).href
);
const { appendSlackStream } = await import(
  pathToFileURL(path.join(repoPath, "extensions/slack/src/streaming.ts")).href
);

async function runScenario(scenario) {
  const requests = [];
  let stopCount = 0;
  let postCount = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody.startsWith("{")
      ? JSON.parse(rawBody)
      : Object.fromEntries(new URLSearchParams(rawBody));
    const method = (request.url ?? "").replace(/^\/api\//u, "");
    requests.push({ method, body });
    let result;
    if (method === "users.info") {
      result = { ok: true, user: { id: "U123", team_id: "T123" } };
    } else if (method === "chat.startStream") {
      result = { ok: true, ts: "171234.900" };
    } else if (method === "chat.appendStream") {
      result = { ok: false, error: "message_not_in_streaming_state" };
    } else if (method === "chat.stopStream") {
      stopCount += 1;
      result =
        stopCount === 1
          ? { ok: false, error: "message_not_in_streaming_state" }
          : { ok: true, ts: "171234.900" };
    } else if (method === "chat.postMessage") {
      postCount += 1;
      result = { ok: true, channel: "C123", ts: `171234.${900 + postCount}` };
    } else {
      result = { ok: false, error: "unsupported_method" };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback server did not bind");
  }
  const slackApiUrl = `http://127.0.0.1:${address.port}/api/`;
  const client = new WebClient("xoxb-loopback-proof", {
    slackApiUrl,
    retryConfig: { retries: 0 },
    timeout: 2_000,
  });
  const cfg = { channels: { slack: { accounts: { default: {} } } } };
  const prepared = {
    ctx: { cfg, botToken: "xoxb-loopback-proof", textLimit: 4_000, mediaMaxBytes: 1_000_000 },
    account: { accountId: "default" },
    message: { channel: "C123", thread_ts: "171234.123", user: "U123", ts: "171234.111" },
    eventScope: { teamId: "T123", client, writeClient: client },
    replyTarget: "C123",
    ctxPayload: { SessionKey: "proof-session", To: "channel:C123" },
    route: { agentId: "default", sessionKey: "proof-session" },
    replyToMode: "all",
    isDirectMessage: false,
    isRoomish: true,
  };
  const errors = [];
  const delivery = createSlackStreamingDeliveryRuntime({
    isThreadReply: true,
    messageSentHookContext: {},
    messageSentHookTarget: "channel:C123",
    prepared,
    replyDeliveryMode: "all",
    replyPlan: {
      nextThreadTs: () => "171234.123",
      peekThreadTs: () => "171234.123",
      markSent: () => {},
    },
    runtime: { log: () => {}, error: (message) => errors.push(message), verbose: () => {} },
    slackClient: client,
    slackClientOptions: {
      slackApiUrl,
      teamId: "T123",
      retryConfig: { retries: 0 },
      timeout: 2_000,
    },
    slackIdentity: undefined,
    slackStreamFallbackTeamId: "T123",
  });
  const progressStart = "progress".repeat(43);
  const session = await delivery.startStream({
    threadTs: "171234.123",
    text: progressStart,
    chunks: [],
  });
  if (scenario === "expired-after-final") {
    await appendSlackStream({ session, text: " stale progress narration" });
    await delivery.deliverNormally({
      payload: { text: "Final answer delivered normally." },
      kind: "final",
    });
    await delivery.finishStream();
  } else {
    const finalText = "pending final answer ".repeat(20);
    await delivery.deliverWithStreaming({ payload: { text: finalText }, kind: "final" });
  }
  const methods = requests.map(({ method }) => method);
  const posts = requests
    .filter(({ method }) => method === "chat.postMessage")
    .map(({ body }) => (typeof body.text === "string" ? body.text.slice(0, 48) : "<no text>"));
  const result = {
    scenario,
    requests: methods,
    postedTextPrefixes: posts,
    staleProgressPosted: posts.some((text) => text.startsWith("stale progress narration")),
    finalPosted: posts.some(
      (text) =>
        text.startsWith("Final answer delivered normally.") ||
        text.startsWith("pending final answer"),
    ),
    streamErrorObserved: errors.some((message) =>
      message.includes("message_not_in_streaming_state"),
    ),
  };
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(new Error(`loopback server close failed: ${String(error)}`));
        return;
      }
      resolve();
    });
  });
  return result;
}

console.log(
  JSON.stringify(
    {
      label: process.env.PROOF_LABEL ?? null,
      repoSha,
      scenarios: [
        await runScenario("expired-after-final"),
        await runScenario("expired-before-final"),
      ],
    },
    null,
    2,
  ),
);
