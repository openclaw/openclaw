import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";
import { matrixPlugin } from "./channel.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { resolveMatrixConfigForAccount } from "./matrix/client/config.js";
import type { MatrixSetupInput } from "./setup-config.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

function config(matrix: NonNullable<CoreConfig["channels"]>["matrix"]): CoreConfig {
  return { channels: { matrix } };
}
function applyAccount(cfg: CoreConfig, accountId: string, input: MatrixSetupInput) {
  return matrixPlugin.setupContract!.applyAccountConfig({ cfg, accountId, input }) as CoreConfig;
}
function warnings(cfg: CoreConfig, accountId = "default") {
  return matrixPlugin.security?.collectWarnings?.({
    cfg,
    account: resolveMatrixAccount({ cfg, accountId }),
  });
}

describe("matrix target classification", () => {
  it("distinguishes users from rooms", () => {
    expect(matrixPlugin.messaging?.inferTargetChatType?.({ to: "@owner:example.org" })).toBe(
      "direct",
    );
    expect(matrixPlugin.messaging?.inferTargetChatType?.({ to: "!room:example.org" })).toBe(
      "channel",
    );
  });
});

function requireMatrixDirectory() {
  const directory = matrixPlugin.directory;
  if (!directory?.listPeers || !directory.listGroups) {
    throw new Error("expected Matrix directory listPeers/listGroups");
  }
  return { listPeers: directory.listPeers, listGroups: directory.listGroups };
}

function requireDirectoryEntry(
  entries: readonly { kind: string; id: string; name?: string }[],
  kind: string,
  id: string,
) {
  const entry = entries.find((candidate) => candidate.kind === kind && candidate.id === id);
  if (!entry) {
    throw new Error(`expected Matrix directory entry ${kind}:${id}`);
  }
  return entry;
}

describe("matrix directory", () => {
  const runtimeEnv: RuntimeEnv = createRuntimeEnv();

  beforeEach(() => {
    installMatrixTestRuntime();
  });

  it("lists peers and groups from config", async () => {
    const cfg = config({
      dm: { allowFrom: ["matrix:@alice:example.org", "bob"] },
      groupAllowFrom: ["@dana:example.org"],
      groups: {
        "!room1:example.org": { users: ["@carol:example.org"] },
        "#alias:example.org": { users: [] },
      },
    });

    const directory = requireMatrixDirectory();

    const peers = await directory.listPeers({ cfg, runtime: runtimeEnv });
    expect(requireDirectoryEntry(peers, "user", "user:@alice:example.org").name).toBeUndefined();
    expect(requireDirectoryEntry(peers, "user", "bob").name).toBe(
      "incomplete id; expected @user:server",
    );
    expect(requireDirectoryEntry(peers, "user", "user:@carol:example.org").name).toBeUndefined();
    expect(requireDirectoryEntry(peers, "user", "user:@dana:example.org").name).toBeUndefined();

    const groups = await directory.listGroups({ cfg, runtime: runtimeEnv });
    expect(requireDirectoryEntry(groups, "group", "room:!room1:example.org").name).toBeUndefined();
    expect(requireDirectoryEntry(groups, "group", "#alias:example.org").name).toBeUndefined();
  });

  it("resolves replyToMode from account config", () => {
    const cfg = config({
      replyToMode: "off",
      accounts: {
        Assistant: { replyToMode: "all" },
      },
    });

    const resolveReplyToMode = matrixPlugin.threading!.resolveReplyToMode!;
    expect(resolveReplyToMode({ cfg, accountId: "assistant", chatType: "direct" })).toBe("all");
    expect(resolveReplyToMode({ cfg, accountId: "default", chatType: "direct" })).toBe("off");
  });

  it("only exposes real Matrix thread ids in tool context", () => {
    expect(
      matrixPlugin.threading?.buildToolContext?.({
        cfg: {} as CoreConfig,
        context: { To: "room:!room:example.org", ReplyToId: "$reply" },
        hasRepliedRef: { value: false },
      }),
    ).toEqual({
      currentChannelId: "room:!room:example.org",
      currentThreadTs: undefined,
      hasRepliedRef: { value: false },
    });

    expect(
      matrixPlugin.threading?.buildToolContext?.({
        cfg: {} as CoreConfig,
        context: { To: "room:!room:example.org", ReplyToId: "$reply", MessageThreadId: "$thread" },
        hasRepliedRef: { value: true },
      }),
    ).toEqual({
      currentChannelId: "room:!room:example.org",
      currentThreadTs: "$thread",
      hasRepliedRef: { value: true },
    });
  });

  it("exposes Matrix direct user id in dm tool context", () => {
    expect(
      matrixPlugin.threading?.buildToolContext?.({
        cfg: {} as CoreConfig,
        context: {
          From: "matrix:@alice:example.org",
          To: "room:!dm:example.org",
          ChatType: "direct",
          MessageThreadId: "$thread",
        },
        hasRepliedRef: { value: false },
      }),
    ).toEqual({
      currentChannelId: "room:!dm:example.org",
      currentThreadTs: "$thread",
      currentDirectUserId: "@alice:example.org",
      hasRepliedRef: { value: false },
    });
  });

  it("resolves group mention policy from account config", () => {
    const cfg = config({
      groups: {
        "!room:example.org": { requireMention: true },
      },
      accounts: {
        Assistant: {
          groups: {
            "!room:example.org": { requireMention: false },
          },
        },
      },
    });

    expect(matrixPlugin.groups!.resolveRequireMention!({ cfg, groupId: "!room:example.org" })).toBe(
      true,
    );
    expect(
      matrixPlugin.groups!.resolveRequireMention!({
        cfg,
        accountId: "assistant",
        groupId: "!room:example.org",
      }),
    ).toBe(false);

    expect(
      matrixPlugin.groups!.resolveRequireMention!({
        cfg,
        accountId: "assistant",
        groupId: "matrix:room:!room:example.org",
      }),
    ).toBe(false);
  });

  it("does not trust prefixed Matrix aliases in group context", () => {
    const cfg = config({
      groups: {
        "#ops:example.org": { requireMention: false },
      },
    });

    expect(
      matrixPlugin.groups!.resolveRequireMention!({
        cfg,
        groupId: "matrix:room:!room:example.org",
        groupChannel: "matrix:channel:#ops:example.org",
      }),
    ).toBe(true);
  });

  it.each(["default", "assistant"])("reports room warnings against account %s", (accountId) => {
    const cfg = config(
      accountId === "default"
        ? { groupPolicy: "open" }
        : {
            defaultAccount: "assistant",
            accounts: { assistant: { groupPolicy: "open" } },
          },
    );
    const prefix =
      accountId === "default" ? "channels.matrix" : "channels.matrix.accounts.assistant";
    expect(warnings(cfg, accountId)).toEqual([
      {
        checkId: "channels.matrix.groups.open",
        severity: "warn",
        title: "Matrix security warning",
        detail: `Matrix rooms: groupPolicy="open" allows any room to trigger (mention-gated). Set ${prefix}.groupPolicy="allowlist" + ${prefix}.groups (and optionally ${prefix}.groupAllowFrom) to restrict rooms.`,
      },
    ]);
  });

  it("reports invite auto-join warnings only when explicitly enabled", () => {
    expect(warnings(config({ groupPolicy: "allowlist", autoJoin: "always" }), "default")).toEqual([
      '- Matrix invites: autoJoin="always" joins any invited room before message policy applies. Set channels.matrix.autoJoin="allowlist" + channels.matrix.autoJoinAllowlist (or channels.matrix.autoJoin="off") to restrict joins.',
    ]);
  });

  it("writes matrix non-default account credentials under channels.matrix.accounts", () => {
    const cfg = config({
      homeserver: "https://default.example.org",
      accessToken: "default-token",
      deviceId: "DEFAULTDEVICE",
      avatarUrl: "mxc://server/avatar",
      encryption: true,
      threadReplies: "inbound",
      groups: {
        "!room:example.org": { requireMention: true },
      },
    });

    const updated = applyAccount(cfg, "ops", {
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
    });

    const matrix = updated.channels?.matrix;
    expect([matrix?.accessToken, matrix?.deviceId, matrix?.avatarUrl]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const defaultAccount = updated.channels?.["matrix"]?.accounts?.default;
    expect(defaultAccount).toMatchObject({
      accessToken: "default-token",
      homeserver: "https://default.example.org",
      deviceId: "DEFAULTDEVICE",
      avatarUrl: "mxc://server/avatar",
      encryption: true,
      threadReplies: "inbound",
    });
    expect(defaultAccount?.groups).toEqual({ "!room:example.org": { requireMention: true } });
    const opsAccount = updated.channels?.["matrix"]?.accounts?.ops;
    expect(opsAccount).toMatchObject({
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
    });
    const resolvedOps = resolveMatrixConfigForAccount(updated, "ops", {});
    expect(resolvedOps).toMatchObject({
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
    });
    expect(resolvedOps.deviceId).toBeUndefined();
  });

  it("writes default matrix account credentials under channels.matrix.accounts.default", () => {
    const cfg = config({
      homeserver: "https://legacy.example.org",
      accessToken: "legacy-token",
    });

    const updated = applyAccount(cfg, "default", {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "bot-token",
    });

    const matrixConfig = updated.channels?.["matrix"];
    expect(matrixConfig).toMatchObject({
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "bot-token",
    });
    expect(updated.channels?.["matrix"]?.accounts).toBeUndefined();
  });

  it("requires account-scoped env vars when --use-env is set for non-default accounts", () => {
    withEnv(
      {
        MATRIX_OPS_HOMESERVER: undefined,
        MATRIX_OPS_USER_ID: undefined,
        MATRIX_OPS_ACCESS_TOKEN: undefined,
        MATRIX_OPS_PASSWORD: undefined,
      },
      () => {
        const error = matrixPlugin.setupContract!.validateInput?.({
          cfg: {} as CoreConfig,
          accountId: "ops",
          input: { useEnv: true },
        });
        expect(error).toBe(
          'Set per-account env vars for "ops" (for example MATRIX_OPS_HOMESERVER + MATRIX_OPS_ACCESS_TOKEN or MATRIX_OPS_USER_ID + MATRIX_OPS_PASSWORD).',
        );
      },
    );
  });

  it("accepts --use-env for non-default account when scoped env vars are present", () => {
    withEnv(
      {
        MATRIX_OPS_HOMESERVER: "https://ops.example.org",
        MATRIX_OPS_ACCESS_TOKEN: "ops-token",
      },
      () => {
        const error = matrixPlugin.setupContract!.validateInput?.({
          cfg: {} as CoreConfig,
          accountId: "ops",
          input: { useEnv: true },
        });
        expect(error).toBeNull();
      },
    );
  });

  it("clears stored auth fields when switching a Matrix account to env-backed auth", () => {
    withEnv(
      {
        MATRIX_OPS_HOMESERVER: "https://ops.env.example.org",
        MATRIX_OPS_ACCESS_TOKEN: "ops-env-token",
        MATRIX_OPS_DEVICE_ID: "OPSENVDEVICE",
        MATRIX_OPS_DEVICE_NAME: "Ops Env Device",
      },
      () => {
        const cfg = config({
          accounts: {
            ops: {
              homeserver: "https://ops.inline.example.org",
              proxy: "http://127.0.0.1:7890",
              userId: "@ops:inline.example.org",
              accessToken: "ops-inline-token",
              password: "ops-inline-password", // pragma: allowlist secret
              deviceId: "OPSINLINEDEVICE",
              deviceName: "Ops Inline Device",
              encryption: true,
            },
          },
        });

        const updated = applyAccount(cfg, "ops", { useEnv: true, name: "Ops" });

        const opsAccount = updated.channels?.["matrix"]?.accounts?.ops;
        expect(opsAccount).toMatchObject({ name: "Ops", enabled: true, encryption: true });
        expect([
          opsAccount?.homeserver,
          opsAccount?.proxy,
          opsAccount?.userId,
          opsAccount?.accessToken,
          opsAccount?.password,
          opsAccount?.deviceId,
          opsAccount?.deviceName,
        ]).toEqual(Array(7).fill(undefined));
        const resolvedOps = resolveMatrixConfigForAccount(updated, "ops", process.env);
        expect(resolvedOps).toMatchObject({
          homeserver: "https://ops.env.example.org",
          accessToken: "ops-env-token",
          deviceId: "OPSENVDEVICE",
          deviceName: "Ops Env Device",
        });
      },
    );
  });

  it("clears stale access token when switching an account to password auth", () => {
    const cfg = config({
      accounts: {
        default: {
          homeserver: "https://matrix.example.org",
          accessToken: "old-token",
        },
      },
    });

    const updated = applyAccount(cfg, "default", {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: "new-password", // pragma: allowlist secret
    });

    expect(updated.channels?.["matrix"]?.accounts?.default?.password).toBe("new-password");
    expect(updated.channels?.["matrix"]?.accounts?.default?.accessToken).toBeUndefined();
  });
});
