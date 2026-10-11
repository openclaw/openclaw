// Matrix tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { MatrixChannelConfigSchema } from "./config-schema.js";

const MatrixConfigSchema = MatrixChannelConfigSchema.runtime;
if (!MatrixConfigSchema) {
  throw new Error("expected Matrix runtime config schema");
}

describe("MatrixConfigSchema SecretInput", () => {
  it("preserves root and account join-introduction overrides without materializing defaults", () => {
    const result = MatrixConfigSchema.safeParse({
      joinIntro: false,
      accounts: { work: { joinIntro: true, customField: 1 }, inherited: {} },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        joinIntro: false,
        accounts: { work: { joinIntro: true, customField: 1 }, inherited: {} },
      });
      expect(result.data).not.toHaveProperty("accounts.inherited.joinIntro");
    }
  });

  it("publishes account credential SecretInput leaves for Control UI redaction hints", () => {
    const accounts = (
      MatrixChannelConfigSchema.schema as {
        properties?: {
          accounts?: {
            additionalProperties?: {
              properties?: Record<string, unknown>;
            };
          };
        };
      }
    ).properties?.accounts?.additionalProperties?.properties;
    expect(accounts).toHaveProperty("accessToken");
    expect(accounts).toHaveProperty("password");
    expect(accounts).toHaveProperty("joinIntro");
  });

  it.each([["streamMode", { streamMode: "progress" }]])(
    "rejects retired account streaming input (%s) with a doctor pointer",
    (_name, input) => {
      const result = MatrixConfigSchema.safeParse({
        homeserver: "https://matrix.example.org",
        accessToken: "token",
        accounts: { work: input },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        // The channel-config wrapper reshapes failures into { issues }.
        expect(JSON.stringify(result.issues)).toContain("doctor --fix");
      }
    },
  );

  it("keeps schema-open account entries with nested streaming objects", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      accounts: { work: { streaming: { mode: "progress" }, customField: 1 } },
    });
    expect(result.success).toBe(true);
  });
});
