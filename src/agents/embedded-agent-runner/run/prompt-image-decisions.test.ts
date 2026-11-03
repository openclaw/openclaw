import { expect, it } from "vitest";
import { resolvePromptImageDecisions } from "./prompt-image-decisions.js";

it("recomputes the least recently used session while retaining a touched session", async () => {
  const resolve = (session: string, failedMediaCount = 0) =>
    resolvePromptImageDecisions({
      sessionKey: `eviction-test/${session}`,
      message: { role: "user", content: "inspect", timestamp: 1 },
      messageIndex: 0,
      media: [{ url: "media://inbound/image.png", contentType: "image/png" }],
      existingImages: [],
      load: async () => ({ images: [], imageFactIndexes: [], failedMediaCount }),
    });

  await resolve("touched", 1);
  await resolve("oldest", 1);
  for (let index = 0; index < 998; index++) {
    await resolve(`filler-${index}`);
  }
  await resolve("touched");
  await resolve("new");

  expect((await resolve("touched")).failedMediaCount).toBe(1);
  expect((await resolve("oldest")).failedMediaCount).toBe(0);
});
