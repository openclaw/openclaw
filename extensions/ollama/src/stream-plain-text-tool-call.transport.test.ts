// Real HTTP/SSRF/NDJSON proof for #122513 and the delta shape used by tool-call-repair.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOllamaStreamFn } from "./stream-api.js";

const FENCE = "```";

// Split at each opening bracket to exercise protected-range resolution mid-token.
function buildBracketDenseChunks(sections: number) {
  const chunks: string[] = ["Here is the configuration you asked for.\n\n", `${FENCE}toml\n`];
  for (let index = 0; index < sections; index += 1) {
    const id = String(index).padStart(2, "0");
    chunks.push("[", `read.section.${id}]\n`, `name = "section-${id}"\n`);
  }
  const fencedBody = '[read]\n{"path":"fenced.txt"}\n[/read]\n';
  chunks.push("[", fencedBody.slice(1));
  chunks.push(`${FENCE}\n`);
  const trailingCall = '[read]\n{"path":"real.txt"}\n[/read]\n';
  chunks.push("\n", "[", trailingCall.slice(1));
  return { chunks, text: chunks.join(""), fencedBody, trailingCall };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server[Symbol.asyncDispose]()));
});

async function startNdjsonChatServer(chunks: readonly string[]): Promise<string> {
  const record = (content: string, done = false) =>
    `${JSON.stringify({
      model: "proof-model",
      created_at: "2026-01-01T00:00:00Z",
      message: { role: "assistant", content },
      done,
      ...(done ? { done_reason: "stop", prompt_eval_count: 1, eval_count: 1 } : {}),
    })}\n`;
  const server = createServer((req, res) => {
    if (!req.url?.endsWith("/api/chat")) {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const content of chunks) {
        res.write(record(content));
      }
      res.write(record("", true));
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function runThroughTransport(
  chunks: readonly string[],
  tools: ReadonlyArray<Record<string, unknown>>,
) {
  const stream = await createOllamaStreamFn(await startNdjsonChatServer(chunks))(
    {
      api: "ollama",
      provider: "ollama",
      id: "proof-model",
      input: ["text"],
      contextWindow: 65536,
    } as never,
    { messages: [{ role: "user", content: "config?" }], tools } as never,
    {},
  );
  const run = {
    deltaText: "",
    doneText: "",
    errors: Array<unknown>(),
    partialCarryingDeltas: 0,
    toolCallNames: Array<string>(),
  };
  for await (const event of stream) {
    if (event.type === "text_delta") {
      run.deltaText += event.delta;
      if ("partial" in event && event.partial !== undefined) {
        run.partialCarryingDeltas += 1;
      }
    }
    if (event.type === "error") {
      run.errors.push(event.error);
    }
    if (event.type === "done") {
      for (const block of event.message.content) {
        if (block.type === "text") {
          run.doneText += block.text;
        }
        if (block.type === "toolCall") {
          run.toolCallNames.push(block.name);
        }
      }
    }
  }
  return run;
}

const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

describe("plain-text tool-call compat wrapper over the real Ollama NDJSON transport", () => {
  it("keeps a bracket-dense fenced answer byte-identical while normalizing the unfenced call (#122513)", async () => {
    const payload = buildBracketDenseChunks(40);
    const run = await runThroughTransport(payload.chunks, [readTool]);

    expect(run.errors).toEqual([]);
    const fencedPortion = payload.text.slice(0, payload.text.indexOf(payload.trailingCall));
    expect(run.doneText.startsWith(fencedPortion)).toBe(true);
    expect(run.doneText).toContain(payload.fencedBody);
    // Outside the fence the same call must be normalized (scrubbed or promoted).
    expect(run.doneText).not.toContain('"path":"real.txt"');
    expect(run.deltaText).toBe(run.doneText);
  });

  it("passes the identical stream through untouched when no tools are configured (#122513)", async () => {
    const payload = buildBracketDenseChunks(40);
    const run = await runThroughTransport(payload.chunks, []);

    expect(run).toEqual({
      errors: [],
      doneText: payload.text,
      deltaText: payload.text,
      toolCallNames: [],
      partialCarryingDeltas: 0,
    });
  });
});
