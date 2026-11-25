import { describe, expect, it } from "vitest";
import { MatrixChannelConfigSchema } from "./config-schema.js";

const MatrixConfigSchema = MatrixChannelConfigSchema.runtime;
if (!MatrixConfigSchema) {
  throw new Error("expected Matrix runtime config schema");
}

describe("MatrixConfigSchema SecretInput", () => {
  it("preserves root and account join-introduction overrides without materializing defaults", () => {
    const input = {
      joinIntro: false,
      accounts: {
        work: { joinIntro: true, streaming: { mode: "progress" }, customField: 1 },
        inherited: {},
      },
    };
    const result = MatrixConfigSchema.safeParse(input);
    expect(result).toMatchObject({ success: true, data: input });
    if (result.success) {
      expect(result.data).not.toHaveProperty("accounts.inherited.joinIntro");
    }
  });

  it("publishes account credential SecretInput leaves for Control UI redaction hints", () => {
    for (const key of ["accessToken", "password", "joinIntro"]) {
      expect(MatrixChannelConfigSchema.schema).toHaveProperty(
        `properties.accounts.additionalProperties.properties.${key}`,
      );
    }
  });

  it("rejects retired account streaming input with a doctor pointer", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      accounts: { work: { streamMode: "progress" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.issues)).toContain("doctor --fix");
    }
  });
});

describe("MatrixConfigSchema exec approvals", () => {
  it.each([true, false, "auto"] as const)("accepts the shipped enabled mode %s", (enabled) => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      execApprovals: {
        enabled,
        approvers: ["@owner:example.org"],
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ execApprovals: { enabled } });
    }
  });

  it("preserves omitted approval enablement without introducing a default", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      execApprovals: { approvers: ["@owner:example.org"] },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        execApprovals: { approvers: ["@owner:example.org"] },
      });
      expect(result.data).not.toMatchObject({
        execApprovals: { enabled: expect.anything() },
      });
    }
  });

  it("preserves the existing non-strict approval object", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      execApprovals: {
        enabled: "auto",
        approvers: ["@owner:example.org"],
        unknownApprovalField: true,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        execApprovals: { enabled: "auto", approvers: ["@owner:example.org"] },
      });
      expect(result.data).not.toMatchObject({
        execApprovals: { unknownApprovalField: true },
      });
    }
  });

  it.each(["AUTO", 1, null])("rejects the invalid enabled mode %s", (enabled) => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      execApprovals: { enabled, approvers: ["@owner:example.org"] },
    });

    expect(result.success).toBe(false);
  });
});
