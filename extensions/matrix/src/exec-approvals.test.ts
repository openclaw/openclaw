// Matrix tests cover exec approvals plugin behavior.
import path from "node:path";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it } from "vitest";
import { normalizeMatrixApproverId } from "./approval-ids.js";
import {
  getMatrixExecApprovalApprovers,
  isMatrixExecApprovalAuthorizedSender,
  isMatrixApprovalClientEnabled,
  resolveMatrixExecApprovalTarget,
  shouldHandleMatrixApprovalRequest,
  shouldSuppressLocalMatrixExecApprovalPrompt,
} from "./exec-approvals.js";
import type { MatrixAccountConfig } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync(sessionRoot);
    cleanup();
  });
});
const sessionRoot = tempDirs.make("openclaw-matrix-exec-approvals-");
type MatrixExecApprovalConfig = NonNullable<MatrixAccountConfig["execApprovals"]>;
type MatrixExecApprovalRequest = ExecApprovalRequest;

function shouldHandleMatrixExecApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ExecApprovalRequest;
}): Promise<boolean> {
  return shouldHandleMatrixApprovalRequest({
    ...params,
    approvalKind: "exec",
  });
}

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>["execApprovals"],
  channelOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>>,
): OpenClawConfig {
  return {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok",
        ...channelOverrides,
        execApprovals,
      },
    },
  } as OpenClawConfig;
}

function matrixAccount(
  accountId: string,
  execApprovals: MatrixExecApprovalConfig,
  overrides: Partial<MatrixAccountConfig> = {},
): MatrixAccountConfig {
  return {
    homeserver: "https://matrix.example.org",
    userId: `@bot-${accountId}:example.org`,
    accessToken: `tok-${accountId}`,
    ...overrides,
    execApprovals,
  };
}

function buildMultiAccountMatrixConfig(params: {
  sessionStorePath?: string;
  defaultExecApprovals?: MatrixExecApprovalConfig;
  opsExecApprovals?: MatrixExecApprovalConfig;
  defaultOverrides?: Partial<MatrixAccountConfig>;
  opsOverrides?: Partial<MatrixAccountConfig>;
}): OpenClawConfig {
  return {
    ...(params.sessionStorePath ? { session: { store: params.sessionStorePath } } : {}),
    channels: {
      matrix: {
        accounts: {
          default: matrixAccount(
            "default",
            params.defaultExecApprovals ?? {
              enabled: true,
              approvers: ["@owner:example.org"],
            },
            params.defaultOverrides,
          ),
          ops: matrixAccount(
            "ops",
            params.opsExecApprovals ?? {
              enabled: true,
              approvers: ["@owner:example.org"],
            },
            params.opsOverrides,
          ),
        },
      },
    },
  } as OpenClawConfig;
}

function makeChannelApprovalRequest(params: {
  id: string;
  sessionKey?: string;
  agentId?: string;
  turnSourceChannel?: string;
}): MatrixExecApprovalRequest {
  return {
    id: params.id,
    request: {
      command: "echo hi",
      agentId: params.agentId ?? "ops-agent",
      sessionKey: params.sessionKey ?? "agent:ops-agent:missing",
      turnSourceChannel: params.turnSourceChannel ?? "slack",
      turnSourceTo: "channel:C123",
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

describe("matrix exec approvals", () => {
  it("requires enablement and approvers before enabling the client", async () => {
    expect(await isMatrixApprovalClientEnabled({ approvalKind: "exec", cfg: buildConfig() })).toBe(
      false,
    );
    expect(
      await isMatrixApprovalClientEnabled({
        approvalKind: "exec",
        cfg: buildConfig(undefined, { dm: { allowFrom: ["@owner:example.org"] } }),
      }),
    ).toBe(false);
    expect(
      await isMatrixApprovalClientEnabled({
        approvalKind: "exec",
        cfg: buildConfig({ enabled: true }),
      }),
    ).toBe(false);
    expect(
      await isMatrixApprovalClientEnabled({
        approvalKind: "exec",
        cfg: buildConfig({ enabled: true }, { dm: { allowFrom: ["@owner:example.org"] } }),
      }),
    ).toBe(true);
    expect(
      await isMatrixApprovalClientEnabled({
        approvalKind: "exec",
        cfg: buildConfig({ enabled: true, approvers: ["@owner:example.org"] }),
      }),
    ).toBe(true);
  });

  it("prefers explicit approvers when configured", () => {
    const cfg = buildConfig(
      { enabled: true, approvers: ["user:@override:example.org"] },
      { dm: { allowFrom: ["@owner:example.org"] } },
    );

    expect(getMatrixExecApprovalApprovers({ cfg })).toEqual(["@override:example.org"]);
    expect(isMatrixExecApprovalAuthorizedSender({ cfg, senderId: "@override:example.org" })).toBe(
      true,
    );
    expect(isMatrixExecApprovalAuthorizedSender({ cfg, senderId: "@owner:example.org" })).toBe(
      false,
    );
  });

  it("ignores wildcard allowlist entries when inferring exec approvers", async () => {
    const cfg = buildConfig({ enabled: true }, { dm: { allowFrom: ["*"] } });

    expect(getMatrixExecApprovalApprovers({ cfg })).toStrictEqual([]);
    expect(await isMatrixApprovalClientEnabled({ approvalKind: "exec", cfg })).toBe(false);
  });

  it("defaults target to dm", () => {
    expect(
      resolveMatrixExecApprovalTarget({
        cfg: buildConfig({ enabled: true, approvers: ["@owner:example.org"] }),
      }),
    ).toBe("dm");
  });

  it("matches matrix target recipients from generic approval forwarding targets", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok",
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [
            { channel: "matrix", to: "user:@target:example.org" },
            { channel: "matrix", to: "room:!ops:example.org" },
          ],
        },
      },
    } as OpenClawConfig;

    expect(isMatrixExecApprovalAuthorizedSender({ cfg, senderId: "@target:example.org" })).toBe(
      true,
    );
    expect(isMatrixExecApprovalAuthorizedSender({ cfg, senderId: "@other:example.org" })).toBe(
      false,
    );
  });

  it("requires an exact Matrix id for approval target recipients", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok",
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "matrix", to: "user:@\u212A:example.org" }],
        },
      },
    } as OpenClawConfig;

    expect(isMatrixExecApprovalAuthorizedSender({ cfg, senderId: "@\u212A:example.org" })).toBe(
      true,
    );
    expect(isMatrixExecApprovalAuthorizedSender({ cfg, senderId: "@k:example.org" })).toBe(false);
  });

  it("suppresses local prompts only when the native client is enabled", async () => {
    const payload = {
      channelData: {
        execApproval: {
          approvalId: "req-1",
          approvalSlug: "req-1",
          agentId: "ops-agent",
          sessionKey: "agent:ops-agent:matrix:channel:!ops:example.org",
        },
      },
    };

    expect(
      await shouldSuppressLocalMatrixExecApprovalPrompt({
        cfg: buildConfig({ enabled: true, approvers: ["@owner:example.org"] }),
        payload,
      }),
    ).toBe(true);

    expect(
      await shouldSuppressLocalMatrixExecApprovalPrompt({
        cfg: buildConfig(),
        payload,
      }),
    ).toBe(false);
  });

  it("suppresses local prompts for plugin approval payloads when DM approvers are configured", async () => {
    const payload = {
      channelData: {
        execApproval: {
          approvalId: "plugin:req-1",
          approvalSlug: "plugin:r",
          approvalKind: "plugin",
        },
      },
    };

    expect(
      await shouldSuppressLocalMatrixExecApprovalPrompt({
        cfg: buildConfig(
          { enabled: true, approvers: ["@owner:example.org"] },
          { dm: { allowFrom: ["@owner:example.org"] } },
        ),
        payload,
      }),
    ).toBe(true);
  });

  it("normalizes prefixed approver ids", () => {
    expect(normalizeMatrixApproverId("matrix:@owner:example.org")).toBe("@owner:example.org");
    expect(normalizeMatrixApproverId("user:@owner:example.org")).toBe("@owner:example.org");
  });

  it("scopes non-matrix turn sources to the stored matrix account", async () => {
    const tmpDir = tempDirs.make("case-", sessionRoot);
    const storePath = path.join(tmpDir, "sessions.json");
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:ops-agent:matrix:channel:!room:example.org",
      entry: {
        sessionId: "main",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          origin: {
            provider: "matrix",
            accountId: "ops",
            to: "room:!room:example.org",
            nativeChannelId: "!room:example.org",
          },
          context: {
            channel: "matrix",
            to: "room:!room:example.org",
            accountId: "ops",
          },
        }),
      },
    });
    const cfg = buildMultiAccountMatrixConfig({ sessionStorePath: storePath });
    const request = makeChannelApprovalRequest({
      id: "req-3",
      sessionKey: "agent:ops-agent:matrix:channel:!room:example.org",
    });

    expect(
      await shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(false);
    expect(
      await shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(true);
  });

  it("ignores disabled matrix accounts when checking unbound account eligibility", async () => {
    const cfg = buildMultiAccountMatrixConfig({
      opsOverrides: { enabled: false },
    });
    const request = makeChannelApprovalRequest({
      id: "req-7",
      turnSourceChannel: "matrix",
    });

    expect(
      await shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(true);
    expect(
      await shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(false);
  });
});
