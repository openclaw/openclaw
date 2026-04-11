import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createGoogleGenAiStreamFnForModel } from "./google-genai-stream.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";

const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "";
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? "global";
const TEST_MODEL = "gemini-flash-latest";

const LIVE = isLiveTestEnabled(["GEMINI_LIVE_TEST"]);

const describeLive = LIVE ? describe : describe.skip;

describeLive("google-genai live tests", () => {
  let originalWindow: any;

  beforeAll(() => {
    originalWindow = (global as any).window;
    (global as any).window = globalThis;
  });

  afterAll(() => {
    if (originalWindow === undefined) {
      delete (global as any).window;
    } else {
      (global as any).window = originalWindow;
    }
  });

  const describeApiKey = GEMINI_KEY ? describe : describe.skip;
  describeApiKey("API Key Access", () => {
    it("can stream responses using API Key", async () => {
      const streamFn = createGoogleGenAiStreamFnForModel({
        id: TEST_MODEL,
        provider: "google-genai",
      });

      const eventStream = streamFn(
        {} as any,
        {
          messages: [
            {
              role: "user",
              content: "Reply with 'Hello from API Key'.",
              timestamp: Date.now(),
            },
          ],
        } as any,
        {
          apiKey: GEMINI_KEY,
        } as any,
      );

      const result = await (eventStream as any).result();
      if (result.stopReason === "error") {
        console.error("API Key Test Failed. Result:", JSON.stringify(result, null, 2));
      }
      expect(result.stopReason).toBe("stop");
      expect(result.content[0].text).toContain("Hello from API Key");
    }, 20000);
  });

  const describeVertex = PROJECT && LOCATION ? describe : describe.skip;
  describeVertex("Vertex AI (ADC) Access", () => {
    it("can stream responses using Vertex AI / ADC", async () => {
      const streamFn = createGoogleGenAiStreamFnForModel({
        id: TEST_MODEL,
        provider: "google-genai",
      });

      // Temporarily remove GEMINI_API_KEY to force ADC fallback
      const oldKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      try {
        const eventStream = streamFn(
          {} as any,
          {
            messages: [
              {
                role: "user",
                content: "Reply with 'Hello from Vertex AI'.",
                timestamp: Date.now(),
              },
            ],
          } as any,
          {} as any, // No API key
        );

        const result = await (eventStream as any).result();
        if (result.stopReason === "error") {
          console.error("Vertex AI Test Failed. Result:", JSON.stringify(result, null, 2));
        }
        expect(result.stopReason).toBe("stop");
        expect(result.content[0].text).toContain("Hello from Vertex AI");
      } finally {
        // Restore GEMINI_API_KEY
        if (oldKey !== undefined) {
          process.env.GEMINI_API_KEY = oldKey;
        }
      }
    }, 20000);
  });
});
