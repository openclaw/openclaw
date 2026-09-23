// Zalouser tests cover zca client plugin behavior.
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

describe("zca-client runtime loading", () => {
  it("loads the packaged CommonJS runtime only when a session is created", async () => {
    vi.resetModules();
    const entry = require.resolve("zca-js");
    const previous = require.cache[entry];
    delete require.cache[entry];
    try {
      const zcaClient = await import("./zca-client.js");
      expect(require.cache[entry]).toBeUndefined();

      const zalo = await zcaClient.createZalo({ logging: false, selfListen: true });

      expect(require.cache[entry]).toBeDefined();
      expect(zalo).toMatchObject({
        options: { logging: false, selfListen: true },
        login: expect.any(Function),
        loginQR: expect.any(Function),
      });
    } finally {
      if (previous) {
        require.cache[entry] = previous;
      } else {
        delete require.cache[entry];
      }
    }
  });
});
