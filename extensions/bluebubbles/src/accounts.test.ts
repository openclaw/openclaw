import { describe, expect, it } from "vitest";
import { resolveBlueBubblesAccount } from "./accounts.js";

describe("resolveBlueBubblesAccount", () => {
  it("treats SecretRef passwords as configured when serverUrl exists", () => {
    const resolved = resolveBlueBubblesAccount({
      cfg: {
        channels: {
          bluebubbles: {
            enabled: true,
            serverUrl: "http://localhost:1234",
            password: {
              source: "env",
              provider: "default",
              id: "BLUEBUBBLES_PASSWORD",
            },
          },
        },
      },
    });

    expect(resolved.configured).toBe(true);
    expect(resolved.baseUrl).toBe("http://localhost:1234");
  });
});
