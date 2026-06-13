// Slack tests cover doctor plugin behavior.
import { describe, expect, it } from "vitest";
import { slackDoctor } from "./doctor.js";

async function collectSlackWarnings(
  slack: Record<string, unknown>,
  defaults?: Record<string, unknown>,
) {
  return (
    (await Promise.resolve(
      slackDoctor.collectMutableAllowlistWarnings?.({
        cfg: { channels: { ...(defaults ? { defaults } : {}), slack } } as never,
      }),
    )) ?? []
  );
}

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

  it("warns for name-keyed allowlist channels but accepts routed ID forms (#81665)", async () => {
    const warnings = await collectSlackWarnings({
      channels: {
        "example-channel": {},
        development: {},
        C0AL2GDUA7J: {},
        c0al2gdua7k: {},
        "channel:C0AL2GDUA7L": {},
        "channel:c0al2gdua7m": {},
        "channel:customers": {},
        "CHANNEL:C0AL2GDUA7N": {},
        "channel:C0al2gdua7p": {},
        "*": {},
      },
    });

    const nameKeyWarnings = warnings.filter((warning) =>
      warning.includes("Re-key it with the channel's"),
    );
    expect(nameKeyWarnings).toHaveLength(5);
    expect(nameKeyWarnings[0]).toContain('channels.slack.channels."example-channel"');
    expect(nameKeyWarnings[0]).toContain('channels.slack.channels."*" applies instead');
    expect(nameKeyWarnings[1]).toContain('channels.slack.channels."development" is ambiguous');
    expect(nameKeyWarnings[2]).toContain(
      'channels.slack.channels."channel:customers" is ambiguous',
    );
    expect(nameKeyWarnings[3]).toContain('channels.slack.channels."CHANNEL:C0AL2GDUA7N"');
    expect(nameKeyWarnings[4]).toContain('channels.slack.channels."channel:C0al2gdua7p"');
  });

  it("uses account policy and name-matching overrides for name-keyed channels (#81665)", async () => {
    const overlongName = "a".repeat(81);
    const warnings = await collectSlackWarnings({
      groupPolicy: "open",
      channels: { "root-room": {} },
      accounts: {
        inheritedOpen: {
          channels: { general: {} },
        },
        inheritedAllowlist: {
          groupPolicy: "allowlist",
        },
        explicitAllowlist: {
          groupPolicy: "allowlist",
          channels: { engineering: {} },
        },
        nameMatching: {
          groupPolicy: "allowlist",
          dangerouslyAllowNameMatching: true,
          channels: {
            support: {},
            "#help": {},
            "crème-brûlée": {},
            "channel:customers": {},
            "<#C0AL2GDUA7J>": {},
            "slack:C0AL2GDUA7K": {},
            "@help": {},
            "##help": {},
            "help+": {},
            Support: {},
            "-": {},
            ___: {},
            "#--": {},
            [overlongName]: {},
          },
        },
      },
    });

    const nameKeyWarnings = warnings.filter((warning) =>
      warning.includes("Re-key it with the channel's"),
    );
    expect(nameKeyWarnings).toHaveLength(13);
    const rootWarning = nameKeyWarnings.find((warning) =>
      warning.includes('channels.slack.channels."root-room"'),
    );
    expect(rootWarning).toContain("messages from the channel are dropped");
    expect(
      nameKeyWarnings.some((warning) =>
        warning.includes('channels.slack.accounts.explicitAllowlist.channels."engineering"'),
      ),
    ).toBe(true);
    expect(
      nameKeyWarnings.some((warning) =>
        warning.includes(
          'channels.slack.accounts.nameMatching.channels."channel:customers" is ambiguous',
        ),
      ),
    ).toBe(true);
    expect(
      nameKeyWarnings.some((warning) =>
        warning.includes('channels.slack.accounts.nameMatching.channels."<#C0AL2GDUA7J>"'),
      ),
    ).toBe(true);
    expect(
      nameKeyWarnings.some((warning) =>
        warning.includes('channels.slack.accounts.nameMatching.channels."slack:C0AL2GDUA7K"'),
      ),
    ).toBe(true);
    for (const invalidName of [
      "@help",
      "##help",
      "help+",
      "Support",
      "-",
      "___",
      "#--",
      overlongName,
    ]) {
      expect(
        nameKeyWarnings.some((warning) =>
          warning.includes(`channels.slack.accounts.nameMatching.channels."${invalidName}"`),
        ),
      ).toBe(true);
    }

    const sharedOpenWarnings = await collectSlackWarnings(
      { channels: { "shared-room": {} } },
      { groupPolicy: "open" },
    );
    expect(
      sharedOpenWarnings.some((warning) => warning.includes("not a routable Slack channel ID")),
    ).toBe(true);
  });

  it("warns when an open-policy override is keyed by channel name (#81665)", async () => {
    const warnings = await collectSlackWarnings({
      groupPolicy: "open",
      channels: {
        "private-room": { enabled: false },
      },
    });

    expect(warnings).toEqual([expect.stringContaining('channels.slack.channels."private-room"')]);
    expect(warnings[0]).toContain("the channel remains allowed");
  });

  it("does not audit provider defaults as a standalone named account (#81665)", async () => {
    const warnings = await collectSlackWarnings({
      channels: {
        "provider-room": { enabled: false },
      },
      accounts: {
        work: {
          channels: {
            C0AL2GDUA7J: {},
          },
        },
      },
    });

    expect(warnings.some((warning) => warning.includes("provider-room"))).toBe(false);
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
