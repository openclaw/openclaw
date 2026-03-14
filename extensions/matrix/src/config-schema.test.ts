import { describe, expect, it } from "vitest";
import { MatrixConfigSchema } from "./config-schema.js";

describe("MatrixConfigSchema SecretInput", () => {
  it("accepts string recoveryKey at top-level", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      encryption: true,
      recoveryKey: "EsTc LdvM MrJj zsCE DLbK Pjgs DcVT sj8p nRV2 EW5r",
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef recoveryKey at top-level", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      encryption: true,
      recoveryKey: { source: "env", provider: "default", id: "MATRIX_RECOVERY_KEY" },
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

  it("accepts SecretRef password on account", () => {
    const result = MatrixConfigSchema.safeParse({
      accounts: {
        work: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: { source: "env", provider: "default", id: "MATRIX_WORK_PASSWORD" },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
