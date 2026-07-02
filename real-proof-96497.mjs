// Real-runtime proof for #96497: drives the REAL buildGuardedModelFetch transport
// (src/agents/provider-transport-fetch.ts, including the sanitizeOpenAISdkSseResponse
// fix) against a REAL local HTTP server that streams SSE mislabeled as JSON.
// No vitest, no mocks of the transport — real network I/O + real OpenAI SDK parser.
import http from "node:http";
import { Stream } from "openai/streaming";
import { buildGuardedModelFetch } from "./src/agents/provider-transport-fetch.ts";

const HEAD = String(process.env.PROOF_HEAD || "").trim();
console.log(`[proof] openclaw provider transport double-prefix repro (head=${HEAD || "n/a"})`);

// 1. Real local OpenAI-compatible gateway: returns standard SSE frames but MISLABELS
//    content-type as application/json (the vLLM/Ollama/custom-proxy regression trigger).
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.write(
    'data: {"id":"a","choices":[{"index":0,"delta":{"content":"Hi","role":"assistant"}}]}\n\n',
  );
  res.write('data: {"id":"a","choices":[{"index":0,"delta":{"content":" there"}}]}\n\n');
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(
  `[proof] local gateway listening at ${base} (content-type mislabeled as application/json)`,
);

// 2. Real transport. endpointClass resolves to "local" from the loopback baseUrl,
//    so SSRF trusts the configured origin — real fetch hits the real server.
const model = {
  id: "MiniMax-M3",
  provider: "hetu",
  api: "openai-completions",
  baseUrl: base,
};
const guardedFetch = buildGuardedModelFetch(model);

const response = await guardedFetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "MiniMax-M3", stream: true }),
});
console.log(
  `[proof] response status=${response.status} content-type=${response.headers.get("content-type")}`,
);

// 3. Real OpenAI SDK SSE parser consumes the sanitized stream.
const items = [];
let parseError = null;
try {
  for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
    items.push(item);
  }
} catch (err) {
  parseError = err;
}

if (parseError) {
  console.log(`[proof] RESULT: SDK PARSE FAILED -> ${parseError.name}: ${parseError.message}`);
} else {
  console.log(`[proof] RESULT: SDK PARSED ${items.length} frames`);
  for (const item of items) {
    console.log(`[proof]   frame: ${JSON.stringify(item)}`);
  }
}

server.close();
process.exit(parseError ? 1 : 0);
