import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buildMatrixQaConfig } from "./config.js";
import type { MatrixQaProvisionedTopology } from "./topology.js";

function castRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe("matrix qa config", () => {
  const group = (key: string, name: string): MatrixQaProvisionedTopology["rooms"][number] => ({
    key,
    name,
    kind: "group",
    memberRoles: ["driver", "observer", "sut"],
    memberUserIds: ["@driver:matrix-qa.test", "@observer:matrix-qa.test", "@sut:matrix-qa.test"],
    requireMention: true,
    roomId: `!${key}:matrix-qa.test`,
  });
  const topology: MatrixQaProvisionedTopology = {
    defaultRoomId: "!main:matrix-qa.test",
    defaultRoomKey: "main",
    rooms: [
      group("main", "Main"),
      group("secondary", "Secondary"),
      {
        key: "driver-dm",
        kind: "dm",
        memberRoles: ["driver", "sut"],
        memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
        name: "DM",
        requireMention: false,
        roomId: "!dm:matrix-qa.test",
      },
    ],
  };

  const params = {
    driverUserId: "@driver:matrix-qa.test",
    homeserver: "http://127.0.0.1:28008/",
    observerUserId: "@observer:matrix-qa.test",
    sutAccessToken: "sut-token",
    sutAccountId: "sut",
    sutUserId: "@sut:matrix-qa.test",
    topology,
  } satisfies Parameters<typeof buildMatrixQaConfig>[1];

  const build = (
    overrides: Parameters<typeof buildMatrixQaConfig>[1]["overrides"],
    extra: Partial<Parameters<typeof buildMatrixQaConfig>[1]> = {},
  ) => buildMatrixQaConfig({}, { ...params, overrides, ...extra });

  it("preserves the scenario provider plugin without enabling unrelated plugins", () => {
    const matrixPlugin = {
      config: { preserve: "matrix-config" },
      enabled: false,
      hooks: { allowConversationAccess: true, timeoutMs: 1_500 },
      llm: {
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4"],
      },
      subagent: {
        allowModelOverride: true,
        allowedModels: ["anthropic/claude-sonnet-4-6"],
      },
    };
    const next = buildMatrixQaConfig(
      {
        plugins: {
          allow: ["acpx", "memory-core", "qa-lab", "openai"],
          entries: {
            matrix: structuredClone(matrixPlugin),
            openai: { enabled: true },
            unrelated: { enabled: true },
          },
        },
      } as OpenClawConfig,
      params,
    );

    expect(next.plugins?.allow).toEqual(["acpx", "memory-core", "qa-lab", "openai", "matrix"]);
    expect(next.plugins?.allow).not.toContain("unrelated");
    expect(next.plugins?.allow).not.toContain("anthropic");
    expect(next.plugins?.entries?.matrix).toEqual({ ...matrixPlugin, enabled: true });
    expect(next.plugins?.entries?.openai).toEqual({ enabled: true });
  });

  it("honors an explicit DM disable with a provisioned DM room", () => {
    const next = build({ dm: { enabled: false } });

    expect(next.channels?.matrix?.accounts?.sut?.dm).toEqual({ enabled: false });
  });

  it("applies room-keyed Matrix QA config overrides", () => {
    const next = build(
      {
        autoJoin: "allowlist",
        autoJoinAllowlist: [" !dm:matrix-qa.test ", "#ops:matrix-qa.test"],
        agentDefaults: {
          blockStreamingChunk: { breakPreference: "newline", maxChars: 48, minChars: 1 },
          blockStreamingCoalesce: { idleMs: 0, maxChars: 48, minChars: 1 },
        },
        blockStreaming: true,
        dm: { sessionScope: "per-room", threadReplies: "off" },
        encryption: true,
        allowBots: "mentions",
        configuredBotRoles: ["observer"],
        groupAllowFrom: ["@driver:matrix-qa.test", "@observer:matrix-qa.test"],
        groupMentionPatterns: ["\\S"],
        groupsByKey: {
          secondary: {
            allowBots: false,
            requireMention: false,
            tools: { allow: ["sessions_spawn"] },
          },
        },
        replyToMode: "all",
        streaming: "quiet",
        threadBindings: { enabled: true, idleHours: 1, spawnSessions: true },
        threadReplies: "always",
        audio: { echoTranscript: false, enabled: true },
        toolProfile: "coding",
      },
      { observerAccessToken: "observer-token" },
    );

    expect(next.agents?.defaults).toEqual(
      expect.objectContaining({
        blockStreamingChunk: { breakPreference: "newline", maxChars: 48, minChars: 1 },
        blockStreamingCoalesce: { idleMs: 0, maxChars: 48, minChars: 1 },
      }),
    );
    expect(next.tools?.profile).toBe("coding");
    expect(next.tools?.media?.audio).toEqual({
      echoTranscript: false,
      enabled: true,
    });
    expect(next.messages?.groupChat?.mentionPatterns).toEqual(["\\S"]);
    const observer = next.channels?.matrix?.accounts?.["qa-observer-bot-source"];
    expect(observer?.accessToken).toBe("observer-token");
    expect(observer?.enabled).toBe(false);
    expect(observer?.homeserver).toBe("http://127.0.0.1:28008/");
    expect(observer?.userId).toBe("@observer:matrix-qa.test");
    const sut = next.channels?.matrix?.accounts?.sut;
    expect(sut?.allowBots).toBe("mentions");
    expect(sut?.autoJoin).toBe("allowlist");
    expect(sut?.autoJoinAllowlist).toEqual(["!dm:matrix-qa.test", "#ops:matrix-qa.test"]);
    expect((sut?.streaming as { block?: { enabled?: boolean } })?.block?.enabled).toBe(true);
    expect(sut?.dm?.sessionScope).toBe("per-room");
    expect(sut?.dm?.threadReplies).toBe("off");
    expect(sut?.encryption).toBe(true);
    expect(sut?.groupAllowFrom).toEqual(["@driver:matrix-qa.test", "@observer:matrix-qa.test"]);
    expect(sut?.groups?.["!main:matrix-qa.test"]).toEqual({
      enabled: true,
      requireMention: true,
    });
    expect(sut?.groups?.["!secondary:matrix-qa.test"]).toEqual({
      allowBots: false,
      enabled: true,
      requireMention: false,
      tools: {
        allow: ["sessions_spawn"],
      },
    });
    expect(sut?.replyToMode).toBe("all");
    expect((sut?.streaming as { mode?: string })?.mode).toBe("quiet");
    expect(sut?.threadBindings).toEqual({
      enabled: true,
      idleHours: 1,
      spawnSessions: true,
    });
    expect(sut?.threadReplies).toBe("always");
  });

  it("restores owned baseline leaves while preserving current Matrix lifecycle and siblings", () => {
    const adjacent = (current: boolean, key: string) => (current ? { [key]: "current" } : {});
    const fixture = (current: boolean) => ({
      ...(current ? { unrelated: { currentOnly: true } } : {}),
      approvals: {
        exec: { enabled: current, mode: "session", ...adjacent(current, "reviewer") },
      },
      agents: {
        defaults: {
          blockStreamingChunk: { maxChars: current ? 8 : 120 },
          adjacentDefault: current ? "current" : "baseline",
        },
      },
      tools: {
        profile: current ? "coding" : "messaging",
        media: {
          models: [
            {
              provider: "openai",
              model: current ? "previous" : "baseline",
              ...(!current ? { capabilities: ["audio"] } : {}),
            },
          ],
          audio: {
            enabled: current,
            prompt: current ? "previous prompt" : "baseline prompt",
            ...adjacent(current, "adjacentAudio"),
            scope: {
              default: current ? "deny" : "allow",
              rules: [
                {
                  action: current ? "deny" : "allow",
                  match: { chatType: current ? "group" : "direct" },
                },
              ],
            },
          },
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: [current ? "previous" : "baseline"],
          ...adjacent(current, "adjacentMessage"),
        },
      },
      channels: {
        matrix: {
          unknownRoot: current ? "current" : "baseline",
          accounts: {
            ...(current
              ? {
                  sibling: { enabled: false, homeserver: "https://sibling.invalid" },
                  "qa-driver-bot-source": { enabled: false, userId: "@stale:test" },
                  "qa-observer-bot-source": { enabled: false, userId: "@stale:test" },
                }
              : {}),
            sut: {
              allowBots: current ? "mentions" : false,
              autoJoin: "allowlist",
              autoJoinAllowlist: [
                current ? "!previous:matrix-qa.test" : "!baseline:matrix-qa.test",
              ],
              deviceId: current ? "CURRENT-DEVICE" : "BASELINE-DEVICE",
              ...adjacent(current, "lifecycleState"),
              dm: {
                allowFrom: [current ? "@previous:test" : "@baseline:matrix-qa.test"],
                ...adjacent(current, "adjacentDm"),
                enabled: true,
                policy: "open",
                sessionScope: current ? "per-user" : "per-room",
                threadReplies: "always",
              },
              execApprovals: {
                agentFilter: [current ? "previous-agent" : "baseline-agent"],
                approvers: [current ? "@previous:test" : "@baseline:matrix-qa.test"],
                enabled: current,
                sessionFilter: [current ? "previous-session" : "baseline-session"],
                target: current ? "both" : "dm",
                ...adjacent(current, "adjacentApproval"),
              },
              groups: {
                "!main:matrix-qa.test": {
                  allowBots: current ? "mentions" : false,
                  enabled: current,
                  requireMention: current,
                  ...adjacent(current, "adjacentGroup"),
                  tools: {
                    allow: [current ? "previous-allow" : "baseline-allow"],
                    deny: [current ? "previous-deny" : "baseline-deny"],
                    ...adjacent(current, "adjacentTool"),
                  },
                },
                ...(current
                  ? {
                      "!current-only:matrix-qa.test": {
                        adjacentGroup: "preserved",
                        enabled: false,
                      },
                    }
                  : {}),
              },
              streaming: {
                ...adjacent(current, "adjacentStreaming"),
                block: { enabled: true, ...adjacent(current, "adjacentBlock") },
                chunkMode: "newline",
                mode: "quiet",
                preview: { toolProgress: false, ...adjacent(current, "adjacentPreview") },
              },
              threadBindings: {
                enabled: current,
                idleHours: current ? 1 : 12,
                ...adjacent(current, "adjacentBinding"),
              },
            },
          },
        },
      },
    });
    const baselineFixture = fixture(false);
    const baseline = structuredClone(baselineFixture) as unknown as OpenClawConfig;
    const baselineSut = baselineFixture.channels.matrix.accounts.sut;
    const currentFixture = fixture(true);
    const current = currentFixture as unknown as OpenClawConfig;

    const next = buildMatrixQaConfig(baseline, {
      currentConfig: current,
      ...params,
    });

    expect(castRecord(next).unrelated).toEqual({ currentOnly: true });
    expect(next.approvals?.exec).toEqual({
      enabled: false,
      mode: "session",
      reviewer: "current",
    });
    expect(next.agents?.defaults).toMatchObject({
      adjacentDefault: "current",
      blockStreamingChunk: { maxChars: 120 },
    });
    expect(next.tools?.profile).toBe("messaging");
    expect(next.tools?.media).toMatchObject({
      ...baselineFixture.tools.media,
      audio: { ...baselineFixture.tools.media.audio, adjacentAudio: "current" },
    });
    expect(next.messages?.groupChat).toMatchObject({
      adjacentMessage: "current",
      mentionPatterns: ["baseline"],
      visibleReplies: "automatic",
    });
    expect(next.channels?.matrix).toMatchObject({ unknownRoot: "current" });
    expect(next.channels?.matrix?.accounts?.sibling).toEqual(
      currentFixture.channels.matrix.accounts.sibling,
    );
    expect(next.channels?.matrix?.accounts?.["qa-driver-bot-source"]).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.["qa-observer-bot-source"]).toBeUndefined();
    const sut = castRecord(next.channels?.matrix?.accounts?.sut);
    expect(sut).toMatchObject({
      allowBots: false,
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!baseline:matrix-qa.test"],
      deviceId: "CURRENT-DEVICE",
      lifecycleState: "current",
      textChunkLimit: 4000,
      dm: {
        adjacentDm: "current",
        allowFrom: ["@driver:matrix-qa.test"],
        sessionScope: "per-room",
        threadReplies: "always",
      },
      execApprovals: { ...baselineSut.execApprovals, adjacentApproval: "current" },
      streaming: {
        adjacentStreaming: "current",
        block: { adjacentBlock: "current", enabled: false },
        chunkMode: "length",
        mode: "off",
        preview: { adjacentPreview: "current", toolProgress: true },
      },
      threadBindings: { ...baselineSut.threadBindings, adjacentBinding: "current" },
    });
    const sutGroups = castRecord(sut.groups);
    expect(sutGroups["!main:matrix-qa.test"]).toEqual({
      adjacentGroup: "current",
      allowBots: false,
      enabled: true,
      requireMention: true,
      tools: { ...baselineSut.groups["!main:matrix-qa.test"].tools, adjacentTool: "current" },
    });
    expect(sutGroups["!current-only:matrix-qa.test"]).toEqual({
      adjacentGroup: "preserved",
      enabled: false,
    });

    const provisioned = buildMatrixQaConfig(baseline, {
      currentConfig: current,
      ...params,
      sutDeviceId: "PROVISIONED-DEVICE",
    });
    expect(provisioned.channels?.matrix?.accounts?.sut).toMatchObject({
      deviceId: "PROVISIONED-DEVICE",
      lifecycleState: "current",
    });
  });

  it("normalizes Matrix QA overrides into the written account config", () => {
    const config = build({
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!ops:matrix-qa.test"],
      blockStreaming: true,
      dm: {
        sessionScope: "per-room",
      },
      groupMentionPatterns: ["\\S"],
      groupPolicy: "open",
      streaming: true,
    });
    const account = config.channels?.matrix?.accounts?.sut;
    expect(account?.autoJoin).toBe("allowlist");
    expect(account?.autoJoinAllowlist).toEqual(["!ops:matrix-qa.test"]);
    expect(account?.dm?.sessionScope).toBe("per-room");
    expect(account?.groupPolicy).toBe("open");
    expect(account?.streaming).toEqual({
      block: { enabled: true },
      chunkMode: "length",
      mode: "partial",
      preview: { toolProgress: true },
    });
    expect(config.messages?.groupChat?.mentionPatterns).toEqual(["\\S"]);
  });

  it("resets progress and preview overrides when a scalar follows an object", () => {
    const defaultStreaming = {
      block: { enabled: false },
      chunkMode: "length",
      mode: "quiet",
      preview: { toolProgress: true },
    };
    const optedOut = build({
      streaming: {
        mode: "quiet",
        progress: { commandText: "raw" },
        preview: { toolProgress: false },
      },
    });
    const reset = build({ streaming: "quiet" }, { currentConfig: optedOut });

    expect(optedOut.channels?.matrix?.accounts?.sut?.streaming).toEqual({
      ...defaultStreaming,
      progress: { commandText: "raw" },
      preview: { toolProgress: false },
    });
    expect(reset.channels?.matrix?.accounts?.sut?.streaming).toEqual(defaultStreaming);
  });

  it("applies Matrix approval delivery overrides with gateway forwarding enabled", () => {
    const next = build({
      approvalForwarding: {
        exec: true,
        plugin: true,
      },
      chunkMode: "length",
      dm: {
        enabled: true,
      },
      execApprovals: {
        enabled: true,
        target: "both",
      },
      textChunkLimit: 280,
    });

    expect(next.approvals?.exec).toEqual({ enabled: true, mode: "session" });
    expect(next.approvals?.plugin).toEqual({ enabled: true, mode: "session" });
    const sut = next.channels?.matrix?.accounts?.sut;
    expect((sut?.streaming as { chunkMode?: string })?.chunkMode).toBe("length");
    expect(sut?.dm?.allowFrom).toEqual(["@driver:matrix-qa.test"]);
    expect(sut?.dm?.enabled).toBe(true);
    expect(sut?.execApprovals).toEqual({
      enabled: true,
      target: "both",
    });
    expect(sut?.textChunkLimit).toBe(280);
  });

  it("resolves role-based Matrix sender allowlist overrides", () => {
    const config = build({
      groupAllowRoles: ["driver", "observer"],
    });

    expect(config.channels?.matrix?.accounts?.sut?.groupAllowFrom).toEqual([
      "@driver:matrix-qa.test",
      "@observer:matrix-qa.test",
    ]);
  });

  it("rejects configured bot roles without matching side-account auth", () => {
    expect(() => build({ configuredBotRoles: ["observer"] })).toThrow(
      'Matrix QA configured bot role "observer" requires an access token',
    );
  });

  it("rejects the SUT role as a configured bot source", () => {
    expect(() => build({ configuredBotRoles: ["sut"] })).toThrow(
      'Matrix QA configured bot role "sut" would match the SUT account itself',
    );
  });

  it("rejects unknown room-key overrides", () => {
    expect(() => build({ groupsByKey: { ghost: { requireMention: false } } })).toThrow(
      'Matrix QA group override references unknown room key "ghost"',
    );
  });
});
