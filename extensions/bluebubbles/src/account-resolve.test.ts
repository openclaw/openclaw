import { describe, expect, it } from "vitest";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";

describe("resolveBlueBubblesServerAccount", () => {
  it("respects an explicit private-network opt-out for loopback server URLs", () => {
    expect(
      resolveBlueBubblesServerAccount({
        serverUrl: "http://127.0.0.1:1234",
        password: "test-password",
        cfg: {
          channels: {
            bluebubbles: {
              network: {
                dangerouslyAllowPrivateNetwork: false,
              },
            },
          },
        },
      }),
    ).toMatchObject({
      baseUrl: "http://127.0.0.1:1234",
      password: "test-password",
      allowPrivateNetwork: false,
    });
  });
});
