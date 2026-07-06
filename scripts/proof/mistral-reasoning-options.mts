// Real behavior proof: Mistral provider forwards reasoning options even when
// the static model manifest marks reasoning as disabled.
//
// The proof calls streamSimpleMistral with a model whose manifest has
// reasoning: false, intercepts the outgoing HTTP request via a custom fetch,
// and verifies that prompt_mode/reasoning_effort are still included when the
// caller explicitly requests reasoning.

import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

let capturedBody: Record<string, unknown> | undefined;
const originalFetch = globalThis.fetch;
// @ts-expect-error proof-only fetch replacement
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(input, init);
  try {
    const text = await request.clone().text();
    capturedBody = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    // ignore parse errors
  }
  // Return a minimal SSE stream so the SDK parser terminates cleanly.
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"object":"chat.completion.chunk"}\n\n'),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

const { streamSimpleMistral } = await import(
  path.join(repoRoot, "packages/ai/src/providers/mistral.js")
);

const model = {
  id: "mistral-large-latest",
  name: "Mistral Large",
  api: "mistral-conversations",
  provider: "mistral",
  baseUrl: "https://api.mistral.ai",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
} as const;

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

console.log("=== Proof: Mistral reasoning options forwarded despite reasoning: false ===\n");

const stream = streamSimpleMistral(model as never, context, {
  apiKey: "sk-proof",
  reasoning: "low",
});
await stream.result();

globalThis.fetch = originalFetch;

console.log(`Payload prompt_mode: ${capturedBody?.prompt_mode ?? "<undefined>"}`);
console.log(`Payload reasoning_effort: ${capturedBody?.reasoning_effort ?? "<undefined>"}`);

if (capturedBody?.prompt_mode === "reasoning") {
  console.log(
    "\nPASS: reasoning option was forwarded as prompt_mode despite model.reasoning=false.",
  );
} else {
  console.log("\nFAIL: reasoning option was stripped.");
  process.exitCode = 1;
}
