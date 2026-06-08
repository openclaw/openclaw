import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses.js";
import { sanitizeResponsesInput } from "../../src/llm/providers/openai-responses-shared.js";

/**
 * A mock fetch that simulates a strict OpenAI-compatible provider.
 * It rejects any request where a message item has `content: null`
 * with a 400 schema error — matching the behavior reported in #90094.
 */
async function strictProviderFetch(url: string, init: RequestInit): Promise<Response> {
  const body = JSON.parse(init.body as string);
  const input = body.input as ResponseInput;

  for (const item of input) {
    const record = item as unknown as Record<string, unknown>;
    if (record.content === null) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Invalid schema: content cannot be null",
            type: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
  }

  return new Response(
    JSON.stringify({
      id: "resp_test",
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function main() {
  console.log("=== Reproduction for issue #90094 ===\n");

  // ============================================================================
  // Proof 1: sanitizeResponsesInput handles all roles correctly
  // ============================================================================
  console.log("-- Proof 1: sanitizeResponsesInput replaces null by role --");
  const dirtyMessages = [
    { role: "user", content: null },
    { role: "system", content: null },
    { role: "developer", content: null },
    { type: "message", role: "assistant", content: null, status: "completed" },
    { role: "user", content: "keep me" },
  ] as unknown as ResponseInput;

  const sanitized = sanitizeResponsesInput([...dirtyMessages]);
  const results = sanitized.map((m) => {
    const r = m as unknown as Record<string, unknown>;
    return { role: r.role, content: r.content };
  });
  console.log("  user      -> content:", JSON.stringify(results[0].content));
  console.log("  system    -> content:", JSON.stringify(results[1].content));
  console.log("  developer -> content:", JSON.stringify(results[2].content));
  console.log("  assistant -> content:", JSON.stringify(results[3].content));
  console.log("  passthrough (user 'keep me') -> content:", JSON.stringify(results[4].content));

  const allClean = results.every((r) => r.content !== null);
  console.log(`  ASSERT: no item has content: null -> ${allClean ? "PASS" : "FAIL"}`);

  // ============================================================================
  // Proof 2: runResponsesStreamLifecycle boundary — onPayload injects null,
  // sanitization happens before SDK call
  // ============================================================================
  console.log("\n-- Proof 2: onPayload middleware boundary (lifecycle path) --");

  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: "https://api.strict-provider.example/v1",
    fetch: strictProviderFetch,
  });

  // Simulate params where a downstream onPayload callback introduces content: null
  const baseInput: ResponseInput = [
    { role: "user", content: "hello" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }], status: "completed" },
  ];

  // --- Case A: dirty input goes straight to SDK (no sanitization) ---
  const dirtyInput = [...baseInput];
  (dirtyInput[1] as unknown as Record<string, unknown>).content = null;

  console.log("  Case A: dirty input (null after onPayload) sent to SDK:");
  console.log("    Request body input[1].content:", JSON.stringify((dirtyInput[1] as unknown as Record<string, unknown>).content));
  try {
    await client.responses.create(
      {
        model: "gpt-5.5",
        input: dirtyInput,
        stream: true,
        store: false,
      } as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
      { maxRetries: 0 },
    );
    console.log("    UNEXPECTED: Request succeeded");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`    EXPECTED FAILURE: ${message}`);
  }

  // --- Case B: same dirty input, but sanitizeResponsesInput applied before SDK ---
  const cleanInput = sanitizeResponsesInput([...dirtyInput]);

  console.log("\n  Case B: sanitized input (null replaced) sent to SDK:");
  console.log("    Request body input[1].content:", JSON.stringify((cleanInput[1] as unknown as Record<string, unknown>).content));
  try {
    await client.responses.create(
      {
        model: "gpt-5.5",
        input: cleanInput,
        stream: true,
        store: false,
      } as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
      { maxRetries: 0 },
    );
    console.log("    SUCCESS: Request accepted by strict provider");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`    UNEXPECTED FAILURE: ${message}`);
  }

  // ============================================================================
  // Proof 3: SDK serialization before/after comparison
  // ============================================================================
  console.log("\n-- Proof 3: serialized request body before vs after sanitize --");

  // Build a fresh dirty input (do not reuse dirtyInput from Proof 2, which was
  // mutated in-place by sanitizeResponsesInput).
  const freshDirtyInput: ResponseInput = [
    { role: "user", content: "hello" },
    { type: "message", role: "assistant", content: null, status: "completed" },
  ] as unknown as ResponseInput;

  const beforeParams = {
    model: "gpt-5.5",
    input: freshDirtyInput,
    stream: true,
    store: false,
  };

  console.log("  BEFORE sanitize — input[1] in JSON:");
  const beforeJson = JSON.stringify((beforeParams.input[1] as unknown as Record<string, unknown>).content);
  console.log(`    ${beforeJson}`);

  const afterParams = {
    model: "gpt-5.5",
    input: sanitizeResponsesInput([...freshDirtyInput]),
    stream: true,
    store: false,
  };

  console.log("  AFTER sanitize — input[1] in JSON:");
  const afterJson = JSON.stringify((afterParams.input[1] as unknown as Record<string, unknown>).content);
  console.log(`    ${afterJson}`);

  const beforeHasNull = beforeJson === "null";
  const afterHasNull = afterJson === "null";
  console.log(`  ASSERT: before contains null=${beforeHasNull}, after contains null=${afterHasNull} -> ${beforeHasNull && !afterHasNull ? "PASS" : "FAIL"}`);

  console.log("\n=========================");
  console.log("All proofs completed.");
}

main().catch(console.error);
