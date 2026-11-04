import { describe, expect, it } from "vitest";
import { createResponseModelTracker } from "./openai-transport-shared.js";

async function track(events: unknown[], response?: Response) {
  const tracker = createResponseModelTracker();
  const stream = (async function* () {
    yield* events;
  })();
  for await (const event of tracker.track(response, stream)) {
    void event;
  }
  return tracker.resolve();
}

describe("OpenAI response model tracker", () => {
  it("prefers a compatible dated model header over an undated lifecycle model", async () => {
    await expect(
      track(
        [{ type: "response.created", response: { model: "gpt-5.6-luna" } }],
        new Response(null, {
          headers: { "openai-model": "gpt-5.6-luna-2026-08-01" },
        }),
      ),
    ).resolves.toBe("gpt-5.6-luna-2026-08-01");
  });

  it("fails closed on conflicting WebSocket event evidence", async () => {
    await expect(
      track([
        { headers: { "openai-model": "gpt-5.6-sol" } },
        {
          type: "response.completed",
          response: { headers: { "x-openai-model": "gpt-5.6-terra-2026-08-01" } },
        },
      ]),
    ).rejects.toThrow("Conflicting OpenAI response model attestations");
  });

  it("fails closed on conflicting lifecycle model evidence", async () => {
    await expect(
      track([
        { type: "response.created", response: { model: "gpt-5.6-sol" } },
        { type: "response.completed", response: { model: "gpt-5.6-terra" } },
      ]),
    ).rejects.toThrow("Conflicting OpenAI response model attestations");
  });
});
