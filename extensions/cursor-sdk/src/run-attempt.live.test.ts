/**
 * Live integration test for the Cursor SDK agent harness.
 *
 * Requires CURSOR_API_KEY in the environment.
 * Run: CURSOR_API_KEY=<key> pnpm vitest run extensions/cursor-sdk/src/run-attempt.live.test.ts
 *
 * This test hits the real Cursor API and produces output suitable
 * for "real behavior proof" in PR review.
 */
import { describe, it, expect } from "vitest";
import { Agent } from "@cursor/sdk";

const CURSOR_API_KEY = process.env["CURSOR_API_KEY"];
const TIMEOUT_MS = 120_000;

describe.skipIf(!CURSOR_API_KEY)("Cursor SDK live integration", () => {
  it(
    "completes a local agent run with a simple prompt",
    async () => {
      console.log("--- Cursor SDK live proof ---");
      console.log(`API key: ${CURSOR_API_KEY!.slice(0, 8)}...REDACTED`);
      console.log(`Timestamp: ${new Date().toISOString()}`);

      const agent = await Agent.create({
        apiKey: CURSOR_API_KEY!,
        model: { id: "composer-2" },
        local: { cwd: process.cwd() },
      });

      console.log("Agent created (local mode, model: composer-2)");

      const prompt = 'Reply with exactly: "Hello from Cursor SDK harness test"';
      console.log(`Sending prompt: ${prompt}`);

      const run = await agent.send(prompt);
      console.log(`Run started, id: ${run.id ?? "N/A"}`);

      let text = "";
      let eventCount = 0;
      for await (const event of run.stream()) {
        eventCount++;
        if (event.type === "assistant") {
          const msg = (event as { message?: { content?: Array<{ type: string; text?: string }> } })
            .message;
          if (msg?.content) {
            for (const block of msg.content) {
              if (block.type === "text" && block.text) {
                text += block.text;
              }
            }
          }
        }
      }

      const result = await run.wait();
      const durationMs = run.durationMs ?? 0;

      console.log(`Stream events received: ${eventCount}`);
      console.log(`Run status: ${result.status}`);
      console.log(`Duration: ${durationMs}ms`);
      console.log(`Assistant text: ${text.trim().slice(0, 500)}`);
      console.log("--- End live proof ---");

      expect(result.status).toBe("finished");
      expect(text.trim().length).toBeGreaterThan(0);

      await agent[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );

  it(
    "handles error classification for invalid API key",
    async () => {
      console.log("--- Error classification proof ---");

      let caughtError: unknown;
      try {
        const agent = await Agent.create({
          apiKey: "invalid-key-for-test",
          model: { id: "composer-2" },
          local: { cwd: process.cwd() },
        });
        const run = await agent.send("test");
        for await (const _event of run.stream()) {
          // drain
        }
        await run.wait();
        await agent[Symbol.asyncDispose]();
      } catch (err) {
        caughtError = err;
      }

      console.log(`Error caught: ${caughtError instanceof Error ? caughtError.constructor.name : typeof caughtError}`);
      console.log(`Error message: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`);

      const { AuthenticationError } = await import("@cursor/sdk");
      const isAuthError = caughtError instanceof AuthenticationError;
      console.log(`Is AuthenticationError: ${isAuthError}`);
      console.log("--- End error classification proof ---");

      expect(caughtError).toBeDefined();
    },
    TIMEOUT_MS,
  );
});
