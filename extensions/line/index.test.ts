import path from "node:path";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";

describe("line runtime api", () => {
  it("loads through Jiti without duplicate export errors", () => {
    const runtimeApiPath = path.join(process.cwd(), "extensions", "line", "runtime-api.ts");
    const jiti = createJiti(import.meta.url, {
      fsCache: false,
      moduleCache: false,
      tryNative: false,
    });

    expect(jiti(runtimeApiPath)).toMatchObject({
      buildTemplateMessageFromPayload: expect.any(Function),
      downloadLineMedia: expect.any(Function),
      isSenderAllowed: expect.any(Function),
      probeLineBot: expect.any(Function),
      pushMessageLine: expect.any(Function),
    });
  }, 240_000);
});
