import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackDoctor } from "./doctor.js";

const mocks = vi.hoisted(() => ({ probeSlack: vi.fn() }));

vi.mock("./probe.js", () => ({
  probeSlack: mocks.probeSlack,
}));

async function collectSlackWarnings(
  slack: Record<string, unknown>,
  defaults?: Record<string, unknown>,
) {
  return (
    (await slackDoctor.collectMutableAllowlistWarnings?.({
      cfg: { channels: { ...(defaults ? { defaults } : {}), slack } } as never,
    })) ?? []
  );
}

function normalizeSlack(slack: Record<string, unknown>) {
  const normalize = slackDoctor.normalizeCompatibilityConfig;
  if (!normalize) {
    throw new Error("Expected slack doctor to expose normalizeCompatibilityConfig");
  }
  return normalize({ cfg: { channels: { slack } } as never });
}

function previewWarnings(slack: Record<string, unknown>) {
  return slackDoctor.collectPreviewWarnings?.({
    cfg: { channels: { slack } } as never,
    doctorFixCommand: "openclaw doctor --fix",
    env: {},
  });
}

function expectWarning(warnings: string[], ...texts: string[]) {
  expect(warnings).toEqual(
    expect.arrayContaining(texts.map((text) => expect.stringContaining(text))),
  );
}

function emptyChannels(...keys: string[]): Record<string, Record<string, never>> {
  return Object.fromEntries(keys.map((key) => [key, {}]));
}

function channelWarnings(warnings: string[]) {
  return warnings.filter((warning) => warning.includes("Re-key it with the channel's"));
}

describe("slack doctor", () => {
  beforeEach(() => {
    mocks.probeSlack.mockReset();
  });

  it("reports when auth.test identifies a bot token instead of a human", async () => {
    mocks.probeSlack.mockResolvedValue({
      ok: false,
      error: "Slack auth.test identified a bot token; user identity requires a user OAuth token",
    });

    const warnings = await previewWarnings({
      postAs: "user",
      userToken: "test-user-token",
      appToken: "test-app-token",
    });

    expect(warnings).toEqual([
      "- channels.slack: userToken auth.test failed: Slack auth.test identified a bot token; user identity requires a user OAuth token.",
    ]);
  });

  it.each([
    {
      name: "Socket Mode app token",
      slack: { postAs: "user", userToken: "test-user-token" },
      expected: "requires appToken for companion-app events",
    },
    {
      name: "HTTP signing secret",
      slack: { postAs: "user", mode: "http", userToken: "test-user-token" },
      expected: "requires signingSecret for companion-app events",
    },
  ])("warns when user identity is missing the $name", async ({ slack, expected }) => {
    mocks.probeSlack.mockResolvedValue({
      ok: true,
      user: { id: "U12345678", name: "test-human" },
    });

    const warnings = await previewWarnings(slack);

    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
    expect(warnings?.join("\n")).not.toContain("test-user-token");
  });

  it("leaves bot-identity doctor behavior unchanged", async () => {
    const warnings = await previewWarnings({
      botToken: "test-bot-token",
      appToken: "test-app-token",
    });

    expect(warnings).toEqual([]);
    expect(mocks.probeSlack).not.toHaveBeenCalled();
  });

  it("warns when mutable allowlist entries rely on disabled name matching", async () => {
    const warnings = await collectSlackWarnings({
      allowFrom: ["alice"],
      accounts: {
        work: { dm: { allowFrom: ["U12345678"] }, channels: { general: { users: ["bob"] } } },
      },
    });
    expectWarning(
      warnings,
      "mutable allowlist entries across slack",
      "channels.slack.allowFrom: alice",
      "channels.slack.accounts.work.channels.general.users: bob",
    );
  });

  it("accepts workspace-qualified channel and user ids as stable policy entries", async () => {
    const warnings = await collectSlackWarnings({
      allowFrom: ["team:T11111111:user:U01234567"],
      channels: {
        "team:T11111111:channel:C01234567": {
          users: ["team:T11111111:user:U01234567"],
        },
      },
    });

    expect(warnings).toEqual([]);
  });

  it("warns for name-keyed allowlist channels but accepts routed ID forms (#81665)", async () => {
    const warnings = await collectSlackWarnings({
      channels: emptyChannels(
        "example-channel",
        "community",
        "C0AL2GDUA7J",
        "c0al2gdua7k",
        "channel:C0AL2GDUA7L",
        "channel:c0al2gdua7m",
        "team:T11111111:channel:C0AL2GDUA7S",
        "D0AL2GDUA7Q",
        "channel:d0al2gdua7r",
        "channel:dabcdefgh",
        "team:T11111111:channel:D0AL2GDUA7T",
        "channel:customers",
        "CHANNEL:C0AL2GDUA7N",
        "channel:C0al2gdua7p",
        "*",
      ),
    });

    const nameKeyWarnings = channelWarnings(warnings);
    expect(nameKeyWarnings).toEqual(
      [
        '"example-channel"',
        '"community" is ambiguous',
        '"channel:customers" is ambiguous',
        '"CHANNEL:C0AL2GDUA7N"',
        '"channel:C0al2gdua7p"',
      ].map((key) => expect.stringContaining(`channels.slack.channels.${key}`)),
    );
    expect(nameKeyWarnings[0]).toContain('channels.slack.channels."*" applies instead');
    const dmWarnings = warnings.filter((warning) =>
      warning.includes("is a Slack DM conversation ID"),
    );
    expect(dmWarnings).toEqual(
      [
        "D0AL2GDUA7Q",
        "channel:d0al2gdua7r",
        "channel:dabcdefgh",
        "team:T11111111:channel:D0AL2GDUA7T",
      ].map((key) => expect.stringContaining(`channels.slack.channels."${key}"`)),
    );
    expect(dmWarnings[0]).toContain("channels.slack.dmPolicy");
  });

  it("uses account policy and name-matching overrides for name-keyed channels (#81665)", async () => {
    const overlongName = "a".repeat(81);
    const invalidNames = ["@help", "##help", "help+", "Support", "-", "___", "#--", overlongName];
    const warnings = await collectSlackWarnings({
      groupPolicy: "open",
      channels: { "root-room": {} },
      accounts: {
        inheritedOpen: { channels: { general: {} } },
        inheritedAllowlist: { groupPolicy: "allowlist" },
        explicitAllowlist: {
          groupPolicy: "allowlist",
          channels: { engineering: {} },
        },
        nameMatching: {
          groupPolicy: "allowlist",
          dangerouslyAllowNameMatching: true,
          channels: emptyChannels(
            "support",
            "#help",
            "crème-brûlée",
            "d0customers",
            "dabcdefgh",
            "channel:customers",
            "<#C0AL2GDUA7J>",
            "slack:C0AL2GDUA7K",
            ...invalidNames,
          ),
        },
      },
    });

    const nameKeyWarnings = channelWarnings(warnings);
    expect(nameKeyWarnings).toHaveLength(13);
    const rootWarning = nameKeyWarnings.find((warning) =>
      warning.includes('channels.slack.channels."root-room"'),
    );
    expect(rootWarning).toContain("messages from the channel are dropped");
    expectWarning(
      nameKeyWarnings,
      'channels.slack.accounts.explicitAllowlist.channels."engineering"',
    );
    for (const key of [
      'channel:customers" is ambiguous',
      '<#C0AL2GDUA7J>"',
      'slack:C0AL2GDUA7K"',
      ...invalidNames.map((name) => `${name}"`),
    ]) {
      expectWarning(nameKeyWarnings, `channels.slack.accounts.nameMatching.channels."${key}`);
    }

    const sharedOpenWarnings = await collectSlackWarnings(
      { channels: { "shared-room": {} } },
      { groupPolicy: "open" },
    );
    expectWarning(sharedOpenWarnings, "not a routable Slack channel ID");
  });

  it("treats bare lowercase D forms as ambiguous without name matching", async () => {
    const warnings = await collectSlackWarnings({
      channels: emptyChannels("d0customers", "dabcdefgh"),
    });

    expect(warnings).toHaveLength(2);
    expect(warnings).toEqual(
      ["d0customers", "dabcdefgh"].map((key) =>
        expect.stringContaining(
          `channels.slack.channels."${key}" is ambiguous: it may be a lowercase Slack DM conversation ID or a channel name`,
        ),
      ),
    );
    expect(warnings[0]).toContain("stable C/G ID");
  });

  it("normalizes legacy slack streaming aliases into the nested streaming shape", () => {
    const result = normalizeSlack({
      streamMode: "status_final",
      chunkMode: "newline",
      blockStreaming: true,
      blockStreamingCoalesce: { idleMs: 250 },
      accounts: { work: { streaming: false, nativeStreaming: false } },
    });

    expect(result.config.channels?.slack?.streaming).toEqual({
      mode: "progress",
      chunkMode: "newline",
      block: { enabled: true, coalesce: { idleMs: 250 } },
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
    const result = normalizeSlack({ streamMode: "status_final", streaming: false });

    expect(result.config.channels?.slack?.streaming).toEqual({
      mode: "progress",
      nativeTransport: false,
    });
    expect(
      result.changes.filter((change) => change.includes("channels.slack.streaming.mode")),
    ).toEqual(["Moved channels.slack.streamMode → channels.slack.streaming.mode (progress)."]);
  });

  it("moves legacy thread mention policy to canonical root and account config", () => {
    const result = normalizeSlack({
      thread: { requireExplicitMention: true, historyScope: "channel" },
      accounts: { work: { thread: { requireExplicitMention: false } } },
    });

    const slack = result.config.channels?.slack;
    expect(slack?.thread).toMatchObject({ historyScope: "channel" });
    expect([
      slack?.implicitMentions,
      slack?.accounts?.work?.implicitMentions,
      slack?.accounts?.work?.thread,
    ]).toEqual([{ threadParticipation: false }, { threadParticipation: true }, undefined]);
    expect(result.changes).toEqual([
      "Moved channels.slack.thread.requireExplicitMention → channels.slack.implicitMentions.threadParticipation (false).",
      "Moved channels.slack.accounts.work.thread.requireExplicitMention → channels.slack.accounts.work.implicitMentions.threadParticipation (true).",
    ]);
  });
});
