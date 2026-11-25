import { describe, expect, it } from "vitest";
import { buildMatrixQaConfig } from "./config.js";
import type { MatrixQaProvisionedTopology } from "./topology.js";

function nest(entries: Array<[string, unknown]>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const children = new Map<string, Array<[string, unknown]>>();
  for (const [path, value] of entries) {
    const [key = "", ...tail] = path.split("/");
    if (tail.length === 0) {
      result[key] = value;
    } else {
      children.set(key, [...(children.get(key) ?? []), [tail.join("/"), value]]);
    }
  }
  for (const [key, child] of children) {
    result[key] = nest(child);
  }
  return result;
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
    };
    const next = buildMatrixQaConfig(
      {
        plugins: {
          allow: ["openai"],
          entries: {
            matrix: structuredClone(matrixPlugin),
            openai: { enabled: true },
            unrelated: { enabled: true },
          },
        },
      },
      params,
    );

    expect(next.plugins?.allow).toEqual(["openai", "matrix"]);
    expect(next.plugins?.entries?.matrix).toEqual({ ...matrixPlugin, enabled: true });
    expect(next.plugins?.entries?.openai).toEqual({ enabled: true });
  });

  it("honors an explicit DM disable with a provisioned DM room", () => {
    const next = build({ dm: { enabled: false } });

    expect(next.channels?.matrix?.accounts?.sut?.dm).toEqual({ enabled: false });
  });

  it("applies room-keyed Matrix QA config overrides", () => {
    const chunk = { maxChars: 48, minChars: 1 };
    const agentDefaults = {
      blockStreamingChunk: { ...chunk, breakPreference: "newline" },
      blockStreamingCoalesce: { ...chunk, idleMs: 0 },
    } as const;
    const threadBindings = { enabled: true, idleHours: 1, spawnSessions: true };
    const audio = { echoTranscript: false, enabled: true };
    const secondary = {
      allowBots: false,
      requireMention: false,
      tools: { allow: ["sessions_spawn"] },
    };
    const accountOverrides = {
      allowBots: "mentions",
      encryption: true,
      replyToMode: "all",
      threadReplies: "always",
      dm: { sessionScope: "per-room", threadReplies: "off" },
      groupAllowFrom: [params.driverUserId, params.observerUserId],
    } as const;
    const next = build(
      {
        ...accountOverrides,
        groupAllowFrom: [...accountOverrides.groupAllowFrom],
        autoJoin: "allowlist",
        autoJoinAllowlist: [" !dm:matrix-qa.test ", "#ops:matrix-qa.test"],
        agentDefaults: structuredClone(agentDefaults),
        blockStreaming: true,
        configuredBotRoles: ["observer"],
        groupMentionPatterns: ["\\S"],
        groupsByKey: { secondary },
        streaming: "quiet",
        threadBindings: structuredClone(threadBindings),
        audio: structuredClone(audio),
        toolProfile: "coding",
      },
      { observerAccessToken: "observer-token" },
    );

    expect(next.agents?.defaults).toEqual(expect.objectContaining(agentDefaults));
    expect(next.tools?.profile).toBe("coding");
    expect(next.tools?.media?.audio).toEqual(audio);
    expect(next.messages?.groupChat?.mentionPatterns).toEqual(["\\S"]);
    expect(next.channels?.matrix?.accounts?.["qa-observer-bot-source"]).toMatchObject({
      accessToken: "observer-token",
      enabled: false,
      homeserver: "http://127.0.0.1:28008/",
      userId: "@observer:matrix-qa.test",
    });
    const sut = next.channels?.matrix?.accounts?.sut;
    expect(sut).toMatchObject({
      ...accountOverrides,
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!dm:matrix-qa.test", "#ops:matrix-qa.test"],
      streaming: { block: { enabled: true }, mode: "quiet" },
    });
    expect(sut?.groups).toEqual({
      "!main:matrix-qa.test": { enabled: true, requireMention: true },
      "!secondary:matrix-qa.test": { ...secondary, enabled: true },
    });
    expect(sut?.threadBindings).toEqual(threadBindings);
  });

  it("restores owned baseline leaves while preserving current Matrix lifecycle and siblings", () => {
    const s = "channels/matrix/accounts/sut";
    const g = s + "/groups/!main:matrix-qa.test";
    const audio = "tools/media/audio";
    const baseModels = [{ provider: "openai", model: "baseline", capabilities: ["audio"] }];
    const baseRules = [{ action: "allow", match: { chatType: "direct" } }];
    const sibling = { enabled: false, homeserver: "https://sibling.invalid" };
    const extraGroup = { adjacentGroup: "preserved", enabled: false };
    const fields: Array<[string, unknown, unknown, unknown?]> = [
      ["unrelated", undefined, { currentOnly: true }, { currentOnly: true }],
      ["approvals/exec/enabled", false, true],
      ["approvals/exec/mode", "session", "session"],
      ["approvals/exec/reviewer", undefined, "current", "current"],
      ["agents/defaults/blockStreamingChunk", { maxChars: 120 }, { maxChars: 8 }],
      ["agents/defaults/adjacentDefault", "baseline", "current", "current"],
      ["tools/profile", "messaging", "coding"],
      ["tools/media/models", baseModels, [{ provider: "openai", model: "previous" }]],
      [audio + "/enabled", false, true],
      [audio + "/prompt", "baseline prompt", "previous prompt"],
      [audio + "/adjacentAudio", undefined, "current", "current"],
      [audio + "/scope/default", "allow", "deny"],
      [audio + "/scope/rules", baseRules, [{ action: "deny", match: { chatType: "group" } }]],
      ["messages/groupChat/mentionPatterns", ["baseline"], ["previous"]],
      ["messages/groupChat/adjacentMessage", undefined, "current", "current"],
      ["channels/matrix/unknownRoot", "baseline", "current", "current"],
      ["channels/matrix/accounts/sibling", undefined, sibling, sibling],
      ...["driver", "observer"].map((role): [string, unknown, unknown] => [
        `channels/matrix/accounts/qa-${role}-bot-source`,
        undefined,
        { enabled: false, userId: "@stale:test" },
      ]),
      [s + "/allowBots", false, "mentions"],
      [s + "/autoJoin", "allowlist", "allowlist"],
      [s + "/autoJoinAllowlist", ["!baseline:matrix-qa.test"], ["!previous:matrix-qa.test"]],
      [s + "/deviceId", "BASELINE-DEVICE", "CURRENT-DEVICE", "CURRENT-DEVICE"],
      [s + "/lifecycleState", undefined, "current", "current"],
      [s + "/dm/allowFrom", ["@baseline:test"], ["@previous:test"], [params.driverUserId]],
      [s + "/dm/enabled", true, true],
      [s + "/dm/policy", "open", "open", "allowlist"],
      [s + "/dm/sessionScope", "per-room", "per-user"],
      [s + "/dm/threadReplies", "always", "always"],
      [s + "/dm/adjacentDm", undefined, "current", "current"],
      [s + "/execApprovals/agentFilter", ["baseline-agent"], ["previous-agent"]],
      [s + "/execApprovals/approvers", ["@baseline:matrix-qa.test"], ["@previous:test"]],
      [s + "/execApprovals/enabled", false, true],
      [s + "/execApprovals/sessionFilter", ["baseline-session"], ["previous-session"]],
      [s + "/execApprovals/target", "dm", "both"],
      [s + "/execApprovals/adjacentApproval", undefined, "current", "current"],
      [g + "/allowBots", false, "mentions"],
      [g + "/enabled", false, true, true],
      [g + "/requireMention", false, true, true],
      [g + "/adjacentGroup", undefined, "current", "current"],
      [g + "/tools/allow", ["baseline-allow"], ["previous-allow"]],
      [g + "/tools/deny", ["baseline-deny"], ["previous-deny"]],
      [g + "/tools/adjacentTool", undefined, "current", "current"],
      [s + "/groups/!current-only:matrix-qa.test", undefined, extraGroup, extraGroup],
      [s + "/streaming/adjacentStreaming", undefined, "current", "current"],
      [s + "/streaming/block/enabled", true, true, false],
      [s + "/streaming/block/adjacentBlock", undefined, "current", "current"],
      [s + "/streaming/chunkMode", "newline", "newline", "length"],
      [s + "/streaming/mode", "quiet", "quiet", "off"],
      [s + "/streaming/preview/toolProgress", false, false, true],
      [s + "/streaming/preview/adjacentPreview", undefined, "current", "current"],
      [s + "/threadBindings/enabled", false, true],
      [s + "/threadBindings/idleHours", 12, 1],
      [s + "/threadBindings/adjacentBinding", undefined, "current", "current"],
    ];
    const expectedValue = (row: (typeof fields)[number]) => (row.length === 4 ? row[3] : row[1]);
    const fixture = (column: 1 | 2 | 3) =>
      nest(
        fields.flatMap((row): Array<[string, unknown]> =>
          (column === 3 ? expectedValue(row) : row[column]) === undefined
            ? []
            : [[row[0], structuredClone(column === 3 ? expectedValue(row) : row[column])]],
        ),
      );
    const baseline = fixture(1);
    const currentConfig = fixture(2);
    const next = buildMatrixQaConfig(baseline, { ...params, currentConfig });
    expect(next).toMatchObject(fixture(3));
    expect(next.messages?.groupChat?.visibleReplies).toBe("automatic");
    expect(next.channels?.matrix?.accounts?.sut?.textChunkLimit).toBe(4000);
    expect(next.channels?.matrix?.accounts?.["qa-driver-bot-source"]).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.["qa-observer-bot-source"]).toBeUndefined();
    const provisioned = buildMatrixQaConfig(baseline, {
      ...params,
      currentConfig,
      sutDeviceId: "PROVISIONED-DEVICE",
    });
    expect(provisioned.channels?.matrix?.accounts?.sut).toMatchObject({
      deviceId: "PROVISIONED-DEVICE",
      lifecycleState: "current",
    });
  });

  it("normalizes boolean streaming and the group policy", () => {
    const config = build({ blockStreaming: true, groupPolicy: "open", streaming: true });
    const account = config.channels?.matrix?.accounts?.sut;
    expect(account?.groupPolicy).toBe("open");
    expect(account?.streaming).toEqual({
      block: { enabled: true },
      chunkMode: "length",
      mode: "partial",
      preview: { toolProgress: true },
    });
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
      approvalForwarding: { exec: true, plugin: true },
      chunkMode: "length",
      dm: { enabled: true },
      execApprovals: { enabled: true, target: "both" },
      textChunkLimit: 280,
    });

    expect(next.approvals?.exec).toEqual({ enabled: true, mode: "session" });
    expect(next.approvals?.plugin).toEqual({ enabled: true, mode: "session" });
    const sut = next.channels?.matrix?.accounts?.sut;
    expect(sut).toMatchObject({
      streaming: { chunkMode: "length" },
      dm: { allowFrom: ["@driver:matrix-qa.test"], enabled: true },
      textChunkLimit: 280,
    });
    expect(sut?.execApprovals).toEqual({ enabled: true, target: "both" });
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

  it.each([
    [
      { configuredBotRoles: ["observer"] },
      'Matrix QA configured bot role "observer" requires an access token',
    ],
    [
      { configuredBotRoles: ["sut"] },
      'Matrix QA configured bot role "sut" would match the SUT account itself',
    ],
    [
      { groupsByKey: { ghost: { requireMention: false } } },
      'Matrix QA group override references unknown room key "ghost"',
    ],
  ] satisfies Array<[Parameters<typeof build>[0], string]>)(
    "rejects invalid overrides %j",
    (overrides, error) => {
      expect(() => build(overrides)).toThrow(error);
    },
  );
});
