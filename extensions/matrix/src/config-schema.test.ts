import { describe, expect, it } from "vitest";
import { MatrixConfigSchema } from "./config-schema.js";

describe("MatrixConfigSchema SecretInput", () => {
  it("accepts SecretRef accessToken at top-level", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: { source: "env", provider: "default", id: "MATRIX_ACCESS_TOKEN" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef password at top-level", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: { source: "env", provider: "default", id: "MATRIX_PASSWORD" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts dm threadReplies overrides", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      dm: {
        policy: "pairing",
        threadReplies: "off",
      },
    });
    expect(result.success).toBe(true);
  });
});
