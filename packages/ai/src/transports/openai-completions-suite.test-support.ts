import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { listenLoopback } from "../../../../test/helpers/gateway-integration-fixtures.js";
import type { AssistantMessageEvent, Context, StreamFn } from "../types.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

type StreamOptions = Parameters<typeof processCompletionsStream>[4];
type Chunks = Parameters<typeof processCompletionsStream>[0];

export function streamFixture(model = makeCompletionsModel()) {
  const output = createAssistantOutput(model);
  const events: AssistantMessageEvent[] = [];
  const sink = { push: (event: AssistantMessageEvent) => events.push(event) };
  const runStream = (chunks: Chunks, options?: StreamOptions) =>
    processCompletionsStream(chunks, output, model, sink, options);
  const run = (chunks: readonly unknown[], options?: StreamOptions) =>
    runStream(streamChunks(chunks), options);
  const text = (parts: Iterable<string>, finish: string | null = "stop") =>
    run([
      ...Array.from(parts, (content) => makeCompletionsChunk({ content })),
      ...(finish === null ? [] : [makeCompletionsChunk({}, finish)]),
    ]);
  return { output, events, run, runStream, text };
}

export function replyContext(content = "Reply OK"): Context {
  return {
    systemPrompt: "system",
    messages: [{ role: "user", content, timestamp: Date.now() }],
    tools: [],
  };
}

export async function collectStream(pending: ReturnType<StreamFn>) {
  const stream = await pending;
  const events = [];
  let text = "",
    thinking = "";
  for await (const event of stream) {
    events.push(event);
    if (event.type === "text_delta") {
      text += event.delta;
    }
    if (event.type === "thinking_delta") {
      thinking += event.delta;
    }
  }
  return { events, text, thinking, terminal: events.at(-1), result: await stream.result() };
}

export function startSse(res: ServerResponse, keepAlive = false) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    ...(keepAlive ? { "cache-control": "no-cache", connection: "keep-alive" } : {}),
  });
}
export function writeSse(res: ServerResponse, chunk: unknown) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => handler(req, res, body));
  });
  const baseUrl = await listenLoopback(server);
  try {
    await run(`${baseUrl}/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
