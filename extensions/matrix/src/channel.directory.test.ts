import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it } from "vitest";
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
const auth = {
  homeserver: "https://matrix.example.org",
  userId: "@ops:example.org",
  accessToken: "ops-token",
};
function validateEnv() {
  return matrixPlugin.setupContract!.validateInput?.({
    cfg: {},
    accountId: "ops",
    input: { useEnv: true },
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

describe("matrix directory", () => {
  const runtime = createRuntimeEnv();
  const threading = matrixPlugin.threading!;
  const requireMention = matrixPlugin.groups!.resolveRequireMention!;

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

    const directory = matrixPlugin.directory!;
    expect(await directory.listPeers!({ cfg, runtime })).toEqual(
      expect.arrayContaining([
        { kind: "user", id: "user:@alice:example.org" },
        { kind: "user", id: "bob", name: "incomplete id; expected @user:server" },
        { kind: "user", id: "user:@carol:example.org" },
        { kind: "user", id: "user:@dana:example.org" },
      ]),
    );
    expect(await directory.listGroups!({ cfg, runtime })).toEqual(
      expect.arrayContaining([
        { kind: "group", id: "room:!room1:example.org" },
        { kind: "group", id: "#alias:example.org" },
      ]),
    );
  });

  it("resolves replyToMode from account config", () => {
    const cfg = config({
      replyToMode: "off",
      accounts: {
        Assistant: { replyToMode: "all" },
      },
    });

    const resolveReplyToMode = threading.resolveReplyToMode!;
    expect(resolveReplyToMode({ cfg, accountId: "assistant", chatType: "direct" })).toBe("all");
    expect(resolveReplyToMode({ cfg, accountId: "default", chatType: "direct" })).toBe("off");
  });

  it.each([
    [{ ReplyToId: "$reply" }, false, undefined, undefined],
    [{ ReplyToId: "$reply", MessageThreadId: "$thread" }, true, "$thread", undefined],
    [
      { From: "matrix:@alice:example.org", ChatType: "direct", MessageThreadId: "$thread" },
      false,
      "$thread",
      "@alice:example.org",
    ],
  ] as const)("builds tool context from %j", (context, value, thread, user) => {
    expect(
      threading.buildToolContext?.({
        cfg: {},
        context: { To: "room:!room:example.org", ...context },
        hasRepliedRef: { value },
      }),
    ).toEqual({
      currentChannelId: "room:!room:example.org",
      currentThreadTs: thread,
      currentDirectUserId: user,
      hasRepliedRef: { value },
    });
  });

  it("resolves group mention policy from account config", () => {
    const cfg = config({
      groups: { "!room:example.org": { requireMention: true } },
      accounts: { Assistant: { groups: { "!room:example.org": { requireMention: false } } } },
    });

    expect(requireMention({ cfg, groupId: "!room:example.org" })).toBe(true);
    for (const groupId of ["!room:example.org", "matrix:room:!room:example.org"]) {
      expect(requireMention({ cfg, accountId: "assistant", groupId })).toBe(false);
    }
  });

  it("does not trust prefixed Matrix aliases in group context", () => {
    const cfg = config({
      groups: {
        "#ops:example.org": { requireMention: false },
      },
    });

    expect(
      requireMention({
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

    const updated = applyAccount(cfg, "ops", auth);

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
    expect(opsAccount).toMatchObject({ enabled: true, ...auth });
    const resolvedOps = resolveMatrixConfigForAccount(updated, "ops", {});
    expect(resolvedOps).toMatchObject(auth);
    expect(resolvedOps.deviceId).toBeUndefined();
  });

  it("writes default matrix account credentials under channels.matrix.accounts.default", () => {
    const cfg = config({
      homeserver: "https://legacy.example.org",
      accessToken: "legacy-token",
    });

    const updated = applyAccount(cfg, "default", auth);

    const matrixConfig = updated.channels?.["matrix"];
    expect(matrixConfig).toMatchObject({ enabled: true, ...auth });
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
        expect(validateEnv()).toBe(
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
        expect(validateEnv()).toBeNull();
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
        expect(updated.channels?.matrix?.accounts?.ops).toEqual({
          name: "Ops",
          enabled: true,
          encryption: true,
        });
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
