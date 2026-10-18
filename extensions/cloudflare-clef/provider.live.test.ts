import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { describe, expect, it } from "vitest";
import { MODEL_IDS } from "./codec.js";
import { createDecisionProvider } from "./provider.js";

// Explicit opt-in: uses the host CLI login and normal Workers AI billing.
const enabled = process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CF_CLEF === "1";
const describeLive = enabled ? describe : describe.skip;
// Synthetic solid-red 256x256 PNG. No user media or credentials are captured.
const redImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAADGklEQVR4nO3OQQ0AMBAEofVvupUxjyNBAHsbnNUPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPINQPIPQBWUwO8hhpVuIAAAAASUVORK5CYII=";

describeLive("Cloudflare Clef CLI typed decisions", () => {
  for (const model of MODEL_IDS) {
    it.each(["text", "image"] as const)(
      `${model}: live %s evidence`,
      async (kind) => {
        const batch: DecisionBatchV2 = {
          state:
            kind === "image"
              ? { type: "image", dataUri: redImage, text: "Evaluate the supplied square." }
              : { type: "text", text: "The large square is entirely red." },
          questions: {
            red: { type: "boolean", instructions: "Is the large square red?" },
            color: {
              type: "choice",
              instructions: "Which is the square's dominant color?",
              criteria: { red: "Red", blue: "Blue" },
            },
            coverage: {
              type: "score",
              instructions: "How much of the square is red?",
              criteria: ["None", "About half", "All"],
            },
          },
        };
        const context: DecisionProviderContextV2 = {
          model: { id: model, provider: "cloudflare-clef", name: model },
          config: {
            plugins: {
              entries: {
                "cloudflare-clef": {
                  config: {
                    ...(process.env.OPENCLAW_LIVE_CF_BINARY
                      ? { binaryPath: process.env.OPENCLAW_LIVE_CF_BINARY }
                      : {}),
                    ...(process.env.OPENCLAW_LIVE_CF_PROFILE
                      ? { profile: process.env.OPENCLAW_LIVE_CF_PROFILE }
                      : {}),
                  },
                },
              },
            },
          },
          auth: { apiKey: "cloudflare-cli", mode: "api-key" },
          signal: new AbortController().signal,
          deadlineMonotonicMs: performance.now() + 30000,
          isAdmissible: () => true,
        };
        const result = await createDecisionProvider().evaluate(batch, context);
        expect(result.status).toBe("ok");
        if (result.status !== "ok") {
          return;
        }
        expect(result.result.model).toBe(model);
        expect(result.result.answers.red).toMatchObject({ type: "boolean" });
        expect(result.result.answers.color).toMatchObject({ type: "choice", choice: "red" });
        const red = result.result.answers.red;
        if (red?.type === "boolean") {
          expect(red.probabilityTrue).toBeGreaterThan(0.5);
        }
        const coverage = result.result.answers.coverage;
        expect(coverage?.type).toBe("score");
        if (coverage?.type === "score") {
          expect(coverage.score).toBeGreaterThan(1);
        }
        console.log(JSON.stringify({ kind, ...result.result }));
      },
      35000,
    );
  }
});
