import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../src/agents/embedded-agent-utils.ts";

const ownershipCases = [
  {
    name: "inline image destination close",
    prefix: "![example `x\n[tool:read] {}\nx` label",
    suffix: "](/url)\n",
  },
  {
    name: "multiline reference title close",
    prefix: '[id]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\n',
    suffix: '"',
  },
  {
    name: "next-line reference destination",
    prefix: "![example `x\n[tool:read] {}\nx`][next]\n\n[next]:\n",
    suffix: "/url\n",
  },
];

for (const example of ownershipCases) {
  const stream = createAssistantVisibleStreamText("final_answer");
  const pending = stream.append(example.prefix);
  const corrected = stream.append(example.suffix);
  const expected = sanitizeAssistantVisibleStreamText(
    example.prefix + example.suffix,
    "final_answer",
  );
  if (!pending.text.includes("[tool:read] {}")) {
    throw new Error(`${example.name}: pending call did not reach final-answer projection`);
  }
  if (corrected.delta !== null || corrected.text.includes("[tool:read] {}")) {
    throw new Error(`${example.name}: ownership correction did not replace pending output`);
  }
  if (corrected.text !== expected) {
    throw new Error(`${example.name}: final text differs from canonical sanitization`);
  }
  console.log(
    JSON.stringify({
      case: example.name,
      phase: "final_answer",
      pendingCallObserved: true,
      correction: "replacement",
      finalText: corrected.text,
    }),
  );
}

const indentationChunks = ["    [tool:read] {}\n", "    ", "[tool:write] {}\n"];
const indentationStream = createAssistantVisibleStreamText("final_answer");
for (const chunk of indentationChunks) {
  indentationStream.append(chunk);
}
const indentationText = indentationChunks.join("");
const indentationExpected = sanitizeAssistantVisibleStreamText(indentationText, "final_answer");
if (
  indentationStream.text !== indentationExpected ||
  !indentationStream.text.includes("[tool:write] {}")
) {
  throw new Error("indented code continuation did not preserve its literal tool calls");
}
console.log(
  JSON.stringify({
    case: "indented code continuation",
    phase: "final_answer",
    literalCallsPreserved: true,
    finalText: indentationStream.text,
  }),
);

const pendingCall = `[tool:write]\n{"path":"notes.txt","content":"${"x".repeat(4_096)}`;
const pendingStream = createAssistantVisibleStreamText("final_answer");
const pendingStartedAt = performance.now();
for (let offset = 0; offset < pendingCall.length; offset += 4) {
  pendingStream.append(pendingCall.slice(offset, offset + 4));
}
const pendingElapsedMs = Math.round(performance.now() - pendingStartedAt);
if (pendingStream.text !== pendingCall) {
  throw new Error("incomplete tool-call candidate did not remain provisional while streaming");
}
console.log(
  JSON.stringify({
    case: "pending-call projection work",
    phase: "final_answer",
    payloadChars: 4_096,
    deltaChars: 4,
    deltaCount: Math.ceil(pendingCall.length / 4),
    elapsedMs: pendingElapsedMs,
    pendingCandidateVisible: true,
    status: "ok",
  }),
);
const cliText = [
  pendingCall,
  '"}\n\n',
  "![example `x\n[tool:read] {}\nx` label](/url)\n\n",
  '[title]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\n"\n\n',
  "![example `x\n[tool:read] {}\nx`][next]\n\n[next]:\n/url\n\n",
  "    [tool:read] {}\n    [tool:write] {}\n\n",
  '```text\n[tool:read] {"path":"example.txt"}\n```\n',
].join("");
const cliChunkSize = 256;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-final-answer-proof-"));
const stateDir = path.join(tempRoot, "state");
const workspace = path.join(tempRoot, "workspace");
const configPath = path.join(tempRoot, "openclaw.json");
await Promise.all([mkdir(stateDir), mkdir(workspace)]);
let streamingRequests = 0;
let responseChunks = 0;

const server = createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const parsed = JSON.parse(body);
    if (parsed.stream !== true) {
      response.writeHead(400).end("streaming Responses request required");
      return;
    }
    streamingRequests += 1;
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    });
    const writeEvent = (event: Record<string, unknown>) => {
      responseChunks += 1;
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const item = {
      id: "msg_local_proof",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      status: "completed",
      content: [{ type: "output_text", text: cliText, annotations: [] }],
    };
    writeEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: item.id, type: item.type, role: item.role, phase: item.phase, content: [] },
    });
    writeEvent({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      part: { type: "output_text", text: "", annotations: [] },
    });
    for (let offset = 0; offset < cliText.length; offset += cliChunkSize) {
      writeEvent({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        delta: cliText.slice(offset, offset + cliChunkSize),
      });
    }
    writeEvent({ type: "response.output_item.done", output_index: 0, item });
    writeEvent({
      type: "response.completed",
      response: {
        id: "resp_local_proof",
        status: "completed",
        model: "stream-proof",
        output: [item],
        usage: { input_tokens: 1, output_tokens: cliText.length, total_tokens: cliText.length + 1 },
      },
    });
    response.end();
  });
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback Responses provider did not bind a TCP port");
  }
  const config = {
    agents: {
      defaults: {
        contextInjection: "never",
        model: { primary: "openai/stream-proof" },
        workspace,
      },
    },
    models: {
      mode: "merge",
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [
            {
              contextWindow: 16_384,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              id: "stream-proof",
              input: ["text"],
              maxTokens: 8_192,
              name: "Local streaming proof",
              reasoning: false,
            },
          ],
        },
      },
    },
    tools: { profile: "minimal" },
  };
  await writeFile(configPath, JSON.stringify(config));

  const env = {
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    OPENAI_API_KEY: "local-proof-key",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_PROFILE: "proof-175328",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_VITEST_RUNTIME: "node",
    PATH: process.env.PATH,
    npm_config_manage_package_manager_versions: "false",
  };
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(process.cwd(), "src/entry.ts"),
      "agent",
      "exec",
      "Return the streamed content exactly.",
      "--model",
      "openai/stream-proof",
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--cwd",
      workspace,
      "--code-mode",
      "direct",
      "--timeout",
      "90",
      "--json",
    ],
    { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`agent exec exited ${exitCode}: ${`${stdout}\n${stderr}`.slice(-4000)}`);
  }
  const result = JSON.parse(stdout.trim());
  const finalText = typeof result.final === "string" ? result.final : "";
  const expectedFinal = sanitizeAssistantVisibleStreamText(cliText, "final_answer");
  const observations = {
    status: result.status,
    streamingRequests,
    finalLength: finalText.length,
    expectedLength: expectedFinal.length,
    matchesCanonical: finalText === expectedFinal,
    pendingPayloadPresent: finalText.includes('[tool:write]\n{"path":"notes.txt"'),
    imageCallPresent: finalText.includes("![example `x\n[tool:read] {}\nx` label](/url)"),
    titleCallPresent: finalText.includes(
      '[title]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\n"',
    ),
    referenceCallPresent: finalText.includes("![example `x\n[tool:read] {}\nx`][next]"),
    indentedCallsPreserved: finalText.includes("    [tool:read] {}\n    [tool:write] {}"),
    fencedControlPreserved: finalText.includes('```text\n[tool:read] {"path":"example.txt"}\n```'),
  };
  if (
    result.status !== "ok" ||
    streamingRequests !== 1 ||
    !observations.matchesCanonical ||
    observations.pendingPayloadPresent ||
    observations.imageCallPresent ||
    observations.titleCallPresent ||
    observations.referenceCallPresent ||
    !observations.indentedCallsPreserved ||
    !observations.fencedControlPreserved
  ) {
    throw new Error(
      `OpenClaw agent exec did not meet the final-answer stream contract: ${JSON.stringify(observations)}`,
    );
  }
  console.log("entrypoint: openclaw agent exec via src/entry.ts");
  console.log("provider: one local OpenAI Responses SSE request");
  console.log("phase: final_answer");
  console.log(
    `pending-call workload: 4,096 payload characters in ${cliChunkSize}-character deltas`,
  );
  console.log(
    `response events: ${responseChunks}; tool-call deltas: ${Math.ceil(pendingCall.length / cliChunkSize)}`,
  );
  console.log(
    "result: resolved image/reference calls hidden; indented and fenced code calls preserved",
  );
  console.log(`status: ${result.status}`);
} finally {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await rm(tempRoot, { recursive: true, force: true });
}
