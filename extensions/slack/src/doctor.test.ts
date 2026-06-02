// Slack tests cover doctor plugin behavior.
import { describe, expect, it } from "vitest";
import { slackDoctor } from "./doctor.js";

function getSlackCompatibilityNormalizer(): NonNullable<
  typeof slackDoctor.normalizeCompatibilityConfig
> {
  const normalize = slackDoctor.normalizeCompatibilityConfig;
  if (!normalize) {
    throw new Error("Expected slack doctor to expose normalizeCompatibilityConfig");
  }
  return normalize;
}

describe("slack doctor", () => {
  it("warns when mutable allowlist entries rely on disabled name matching", async () => {
    const warnings = await Promise.resolve(
      slackDoctor.collectMutableAllowlistWarnings?.({
        cfg: {
          channels: {
            slack: {
              allowFrom: ["alice"],
              accounts: {
                work: {
                  dm: {
                    allowFrom: ["U12345678"],
                  },
                  channels: {
                    general: {
                      users: ["bob"],
                    },
                  },
                },
              },
            },
          },
        } as never,
      }),
    );
    expect(
      warnings?.some((warning) => warning.includes("mutable allowlist entries across slack")),
    ).toBe(true);
    expect(warnings?.some((warning) => warning.includes("channels.slack.allowFrom: alice"))).toBe(
      true,
    );
    expect(
      warnings?.some((warning) =>
        warning.includes("channels.slack.accounts.work.channels.general.users: bob"),
      ),
    ).toBe(true);
  });

  it("warns when a slack channels map is keyed by name instead of channel ID under allowlist (#81665)", async () => {
    const warnings = await Promise.resolve(
      slackDoctor.collectMutableAllowlistWarnings?.({
        cfg: {
          channels: {
            slack: {
              groupPolicy: "allowlist",
              channels: {
                "example-channel": { requireMention: false },
                C0AL2GDUA7J: { requireMention: false },
              },
            },
          },
        } as never,
      }),
    );
    expect(
      warnings?.some(
        (warning) =>
          warning.includes('channels.slack.channels."example-channel"') &&
          warning.includes("keyed by a channel name"),
      ),
    ).toBe(true);
    // The ID-keyed entry is valid and must not be flagged.
    expect(warnings?.some((warning) => warning.includes('channels.slack.channels."C0AL2GDUA7J"'))).toBe(
      false,
    );
  });

  it("does not flag name-keyed slack channels when groupPolicy is open (#81665)", async () => {
    const warnings = await Promise.resolve(
      slackDoctor.collectMutableAllowlistWarnings?.({
        cfg: {
          channels: {
            slack: {
              groupPolicy: "open",
              channels: { "example-channel": { requireMention: false } },
            },
          },
        } as never,
      }),
    );
    expect(warnings?.some((warning) => warning.includes("keyed by a channel name"))).toBe(false);
  });

  it("accepts lowercase and channel:-prefixed Slack ID keys without flagging them (#81665)", async () => {
    const warnings = await Promise.resolve(
      slackDoctor.collectMutableAllowlistWarnings?.({
        cfg: {
          channels: {
            slack: {
              groupPolicy: "allowlist",
              channels: { c0al2gdua7j: { requireMention: false }, "channel:C0AL2GDUA7J": {} },
            },
          },
        } as never,
      }),
    );
    expect(warnings?.some((warning) => warning.includes("keyed by a channel name"))).toBe(false);
  });

  it("does not flag name-keyed channels in accounts that inherit an open provider policy (#81665)", async () => {
    const warnings = await Promise.resolve(
      slackDoctor.collectMutableAllowlistWarnings?.({
        cfg: {
          channels: {
            slack: {
              groupPolicy: "open",
              accounts: { work: { channels: { general: { requireMention: false } } } },
            },
          },
        } as never,
      }),
    );
    expect(warnings?.some((warning) => warning.includes("keyed by a channel name"))).toBe(false);
  });

  it("warns for a configured slack provider that omits groupPolicy (loaded default is allowlist) (#81665)", async () => {
    const warnings = await Promise.resolve(
      slackDoctor.collectMutableAllowlistWarnings?.({
        cfg: {
          channels: { slack: { channels: { "example-channel": { requireMention: false } } } },
        } as never,
      }),
    );
    // The loaded Slack default for an omitted groupPolicy is "allowlist", which silently drops
    // unmatched channels — exactly the config the issue describes — so it must be flagged.
    expect(warnings?.some((warning) => warning.includes("keyed by a channel name"))).toBe(true);
  });

  it("honors channels.defaults.groupPolicy when slack omits its own policy (#81665)", async () => {
    const allowlistDefault = await Promise.resolve(
      slackDoctor.collectMutableAllowlistWarnings?.({
        cfg: {
          channels: {
            defaults: { groupPolicy: "allowlist" },
            slack: { channels: { "example-channel": {} } },
          },
        } as never,
      }),
    );
    expect(allowlistDefault?.some((warning) => warning.includes("keyed by a channel name"))).toBe(
      true,
    );
    const openDefault = await Promise.resolve(
      slackDoctor.collectMutableAllowlistWarnings?.({
        cfg: {
          channels: {
            defaults: { groupPolicy: "open" },
            slack: { channels: { "example-channel": {} } },
          },
        } as never,
      }),
    );
    expect(openDefault?.some((warning) => warning.includes("keyed by a channel name"))).toBe(false);
  });

  it("normalizes legacy slack streaming aliases into the nested streaming shape", () => {
    const normalize = getSlackCompatibilityNormalizer();

    const result = normalize({
      cfg: {
        channels: {
          slack: {
            streamMode: "status_final",
            chunkMode: "newline",
            blockStreaming: true,
            blockStreamingCoalesce: {
              idleMs: 250,
            },
            accounts: {
              work: {
                streaming: false,
                nativeStreaming: false,
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.slack?.streaming).toEqual({
      mode: "progress",
      chunkMode: "newline",
      block: {
        enabled: true,
        coalesce: {
          idleMs: 250,
        },
      },
    });
    expect(result.config.channels?.slack?.accounts?.work?.streaming).toEqual({
      mode: "off",
      nativeTransport: false,
    });
    for (const expectedChange of [
      "Moved channels.slack.streamMode → channels.slack.streaming.mode (progress).",
      "Moved channels.slack.chunkMode → channels.slack.streaming.chunkMode.",
      "Moved channels.slack.blockStreaming → channels.slack.streaming.block.enabled.",
      "Moved channels.slack.blockStreamingCoalesce → channels.slack.streaming.block.coalesce.",
      "Moved channels.slack.accounts.work.streaming (boolean) → channels.slack.accounts.work.streaming.mode (off).",
      "Moved channels.slack.accounts.work.nativeStreaming → channels.slack.accounts.work.streaming.nativeTransport.",
    ]) {
      expect(result.changes).toContain(expectedChange);
    }
  });

  it("does not duplicate streaming.mode change messages when streamMode wins over boolean streaming", () => {
    const normalize = getSlackCompatibilityNormalizer();

    const result = normalize({
      cfg: {
        channels: {
          slack: {
            streamMode: "status_final",
            streaming: false,
          },
        },
      } as never,
    });

    expect(result.config.channels?.slack?.streaming).toEqual({
      mode: "progress",
      nativeTransport: false,
    });
    expect(
      result.changes.filter((change) => change.includes("channels.slack.streaming.mode")),
    ).toEqual(["Moved channels.slack.streamMode → channels.slack.streaming.mode (progress)."]);
  });

  it("moves legacy channel allow toggles into enabled", () => {
    const normalize = getSlackCompatibilityNormalizer();

    const result = normalize({
      cfg: {
        channels: {
          slack: {
            channels: {
              ops: {
                allow: false,
              },
            },
            accounts: {
              work: {
                channels: {
                  general: {
                    allow: true,
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.changes).toEqual([
      "Moved channels.slack.channels.ops.allow → channels.slack.channels.ops.enabled.",
      "Moved channels.slack.accounts.work.channels.general.allow → channels.slack.accounts.work.channels.general.enabled.",
    ]);
    expect(result.config.channels?.slack?.channels?.ops).toEqual({
      enabled: false,
    });
    expect(result.config.channels?.slack?.accounts?.work?.channels?.general).toEqual({
      enabled: true,
    });
  });
});
