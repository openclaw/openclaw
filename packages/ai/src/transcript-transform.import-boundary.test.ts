import { describe, expect, it, vi } from "vitest";
import { transformMessages } from "./transcript-transform.js";
import type { Model } from "./types.js";

vi.mock("./host.js", () => {
  throw new Error("Transcript normalization must not load the transport host");
});

// The host installs this transform as its default. Calling back into the host
// through media inspection creates a cycle and couples their compiler inputs.
describe("host-independent transcript normalization", () => {
  it("omits only images with inline bytes for a text-only model", () => {
    const model: Model<"openai-completions"> = {
      id: "text-only",
      name: "Text only",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://example.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024,
    };
    const result = transformMessages(
      [
        {
          role: "user",
          timestamp: 1,
          content: [
            { type: "image", data: "", mimeType: "image/png" },
            { type: "image", data: "aW1n", mimeType: "image/png" },
          ],
        },
      ],
      model,
    );
    expect(result).toEqual([
      {
        role: "user",
        timestamp: 1,
        content: [{ type: "text", text: "(image omitted: model does not support images)" }],
      },
    ]);
  });
});
