import { describe, expect, it } from "vitest";
import { MatrixChannelConfigSchema } from "./config-schema.js";

const MatrixConfigSchema = MatrixChannelConfigSchema.runtime;
if (!MatrixConfigSchema) {
  throw new Error("expected Matrix runtime config schema");
}
const auth = { homeserver: "https://matrix.example.org", accessToken: "token" };
const approvers = ["@owner:example.org"];
function approvalInput(execApprovals: Record<string, unknown>) {
  return { ...auth, execApprovals: { approvers, ...execApprovals } };
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
    expect(MatrixConfigSchema.parse(input)).toEqual(input);
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
      ...auth,
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
    expect(MatrixConfigSchema.parse(approvalInput({ enabled })).execApprovals).toEqual({
      enabled,
      approvers,
    });
  });

  it("preserves omitted approval enablement without introducing a default", () => {
    expect(MatrixConfigSchema.parse(approvalInput({})).execApprovals).toEqual({ approvers });
  });

  it("preserves the existing non-strict approval object", () => {
    expect(
      MatrixConfigSchema.parse(approvalInput({ enabled: "auto", unknownApprovalField: true }))
        .execApprovals,
    ).toEqual({ enabled: "auto", approvers });
  });

  it.each(["AUTO", 1, null])("rejects the invalid enabled mode %s", (enabled) => {
    expect(MatrixConfigSchema.safeParse(approvalInput({ enabled })).success).toBe(false);
  });
});
