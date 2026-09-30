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

  it("accepts SecretRef accessToken and password on accounts", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accounts: {
        work: {
          joinIntro: true,
          accessToken: { source: "store", provider: "default", id: "MATRIX_WORK_TOKEN" },
          password: { source: "store", provider: "default", id: "MATRIX_WORK_PASSWORD" },
          userId: "@work:example.org",
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected schema parse to succeed");
    }
    expect(result.data).toMatchObject({
      accounts: {
        work: {
          joinIntro: true,
          accessToken: { source: "store", provider: "default", id: "MATRIX_WORK_TOKEN" },
          password: { source: "store", provider: "default", id: "MATRIX_WORK_PASSWORD" },
          userId: "@work:example.org",
        },
      },
    });
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

  it.each([
    [
      "SecretRef accessToken",
      { accessToken: { source: "env", provider: "default", id: "MATRIX_ACCESS_TOKEN" } },
    ],
    [
      "SecretRef password",
      {
        userId: "@bot:example.org",
        password: { source: "env", provider: "default", id: "MATRIX_PASSWORD" },
      },
    ],
    ["dm threadReplies", { accessToken: "token", dm: { policy: "pairing", threadReplies: "off" } }],
    [
      "dm sessionScope",
      { accessToken: "token", dm: { policy: "pairing", sessionScope: "per-room" } },
    ],
    ["name matching compatibility", { accessToken: "token", dangerouslyAllowNameMatching: true }],
  ])("accepts %s", (_name, input) => {
    expect(
      MatrixConfigSchema.safeParse({ homeserver: "https://matrix.example.org", ...input }).success,
    ).toBe(true);
  });

  it.each(["groups", "rooms"] as const)("accepts %s account assignments", (scope) => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      [scope]: { "!room:example.org": { enabled: true, account: "axis" } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ [scope]: { "!room:example.org": { account: "axis" } } });
    }
  });

  it.each(["groups", "rooms"] as const)("rejects unknown %s entry fields", (scope) => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      [scope]: {
        "!room:example.org": {
          enabled: true,
          unknownSetting: true,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts nested quiet Matrix streaming mode with delivery controls", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      streaming: {
        mode: "quiet",
        chunkMode: "newline",
        block: { enabled: true, coalesce: { idleMs: 100 } },
      },
    });
    expect(result.success).toBe(true);
  });

  describe.each(["channel", "account"] as const)("%s room streaming overrides", (scope) => {
    const configWithStreaming = (streaming: unknown) =>
      scope === "channel" ? { streaming } : { accounts: { work: { streaming, customField: 1 } } };

    it.each([true, false])("preserves channel/account and room commentary=%s", (commentary) => {
      const input = configWithStreaming({
        mode: "progress",
        progress: { commentary },
        rooms: { "!room:example.org": { progress: { commentary: !commentary } } },
      });
      const result = MatrixConfigSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject(input);
      }
    });

    it.each([
      { progress: { commentary: "true" } },
      { rooms: { "!room:example.org": { progress: { commentary: "false" } } } },
      { rooms: { "!room:example.org": { progress: { toolProgress: true } } } },
    ])("rejects invalid or unsupported commentary overrides: %j", (streaming) => {
      expect(MatrixConfigSchema.safeParse(configWithStreaming(streaming)).success).toBe(false);
    });

    it("preserves traditional and room-version-12 IDs separately from room policy", () => {
      const input = configWithStreaming({
        mode: "progress",
        rooms: {
          "!quiet:example.org": { mode: "off" },
          "!my room:example.org": { mode: "quiet" },
          "!UIZ0YzC99dC1AyEM6mGl0_XNP8u8xeCCt_Zk8Uhkp70": { mode: "partial" },
        },
      });
      const result = MatrixConfigSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject(input);
      }
    });

    it.each(["*", "#alias:example.org", "room", "!", "!room", " !room:example.org"])(
      "rejects non-literal room-ID streaming key %s",
      (key) => {
        expect(
          MatrixConfigSchema.safeParse(configWithStreaming({ rooms: { [key]: { mode: "off" } } }))
            .success,
        ).toBe(false);
      },
    );

    it("rejects an invalid nested room mode", () => {
      expect(
        MatrixConfigSchema.safeParse(
          configWithStreaming({ rooms: { "!room:example.org": { mode: "typo" } } }),
        ).success,
      ).toBe(false);
    });
  });

  it("publishes the same streaming validation at channel and account scope", () => {
    const schema = MatrixChannelConfigSchema.schema as {
      properties: {
        streaming: unknown;
        accounts: { additionalProperties: { properties: { streaming: unknown } } };
      };
    };
    expect(schema.properties.accounts.additionalProperties.properties.streaming).toEqual(
      schema.properties.streaming,
    );
  });

  it.each(["groups", "rooms"])("rejects streaming under access policy %s", (key) => {
    expect(
      MatrixConfigSchema.safeParse({
        [key]: { "!room:example.org": { streaming: { mode: "off" } } },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["scalar streaming mode", { streaming: "quiet" }],
    ["boolean streaming", { streaming: true }],
  ])("rejects legacy %s spelling", (_name, overrides) => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      ...overrides,
    });
    expect(result.success).toBe(false);
  });

  it("accepts Matrix streaming preview tool progress config", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      streaming: {
        mode: "progress",
        progress: {
          label: "Shelling",
          maxLines: 4,
          toolProgress: false,
          commandText: "status",
        },
        preview: {
          toolProgress: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["boolean streaming", { streaming: true }],
    ["mode string streaming", { streaming: "progress" }],
    ["streamMode", { streamMode: "progress" }],
    ["chunkMode", { chunkMode: "newline" }],
    ["blockStreaming", { blockStreaming: true }],
    ["blockStreamingCoalesce", { blockStreamingCoalesce: { idleMs: 5 } }],
    ["draftChunk", { draftChunk: { minChars: 10 } }],
  ])("rejects retired account streaming input (%s) with a doctor pointer", (_name, input) => {
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
  });

  it("keeps schema-open account entries with nested streaming objects", () => {
    const result = MatrixConfigSchema.safeParse({
      homeserver: "https://matrix.example.org",
      accessToken: "token",
      accounts: { work: { streaming: { mode: "progress" }, customField: 1 } },
    });
    expect(result.success).toBe(true);
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
