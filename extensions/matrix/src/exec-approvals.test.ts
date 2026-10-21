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
const enabled = { enabled: true, approvers: ["@owner:example.org"] };

function matrixAccount(
  accountId = "default",
  overrides: Partial<MatrixAccountConfig> = {},
): MatrixAccountConfig {
  return {
    homeserver: "https://matrix.example.org",
    userId: `@bot-${accountId}:example.org`,
    accessToken: `tok-${accountId}`,
    ...overrides,
  };
}

function buildConfig(
  execApprovals?: MatrixExecApprovalConfig,
  channelOverrides?: Partial<MatrixAccountConfig>,
): OpenClawConfig {
  return {
    channels: {
      matrix: matrixAccount("default", { ...channelOverrides, execApprovals }),
    },
  } as OpenClawConfig;
}

function buildMultiAccountMatrixConfig(params: {
  sessionStorePath?: string;
  opsOverrides?: Partial<MatrixAccountConfig>;
}): OpenClawConfig {
  return {
    ...(params.sessionStorePath ? { session: { store: params.sessionStorePath } } : {}),
    channels: {
      matrix: {
        accounts: {
          default: matrixAccount("default", { execApprovals: enabled }),
          ops: matrixAccount("ops", { ...params.opsOverrides, execApprovals: enabled }),
        },
      },
    },
  } as OpenClawConfig;
}

function makeChannelApprovalRequest(params: {
  id: string;
  sessionKey?: string;
  turnSourceChannel?: string;
}): ExecApprovalRequest {
  return {
    id: params.id,
    request: {
      command: "echo hi",
      agentId: "ops-agent",
      sessionKey: params.sessionKey ?? "agent:ops-agent:missing",
      turnSourceChannel: params.turnSourceChannel ?? "slack",
      turnSourceTo: "channel:C123",
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

function forwardingConfig(targets: Array<{ channel: string; to: string }>): OpenClawConfig {
  return {
    ...buildConfig(),
    approvals: { exec: { enabled: true, mode: "targets", targets } },
  };
}

async function expectEligibility(
  cfg: OpenClawConfig,
  request: ExecApprovalRequest,
  defaultEnabled: boolean,
) {
  const check = (accountId: string) =>
    shouldHandleMatrixApprovalRequest({
      cfg,
      accountId,
      request,
      approvalKind: "exec",
    });
  expect(await check("default")).toBe(defaultEnabled);
  expect(await check("ops")).toBe(!defaultEnabled);
}

describe("matrix exec approvals", () => {
  it("prefers explicit approvers when configured", () => {
    const cfg = buildConfig(
      { enabled: true, approvers: ["user:@override:example.org"] },
      { dm: { allowFrom: ["@owner:example.org"] } },
    );

    expect(getMatrixExecApprovalApprovers({ cfg })).toEqual(["@override:example.org"]);
    expect(
      ["@override:example.org", "@owner:example.org"].map((senderId) =>
        isMatrixExecApprovalAuthorizedSender({ cfg, senderId }),
      ),
    ).toEqual([true, false]);
  });

  it("ignores wildcard allowlist entries when inferring exec approvers", async () => {
    const cfg = buildConfig({ enabled: true }, { dm: { allowFrom: ["*"] } });

    expect(getMatrixExecApprovalApprovers({ cfg })).toStrictEqual([]);
    expect(await isMatrixApprovalClientEnabled({ approvalKind: "exec", cfg })).toBe(false);
  });

  it("defaults target to dm", () => {
    expect(
      resolveMatrixExecApprovalTarget({
        cfg: buildConfig(enabled),
      }),
    ).toBe("dm");
  });

  it.each([
    ["@target:example.org", "@other:example.org", true],
    ["@K:example.org", "@k:example.org", false],
  ] as const)("matches exact forwarding recipient %s", (allowed, denied, includeRoom) => {
    const cfg = forwardingConfig([
      { channel: "matrix", to: `user:${allowed}` },
      ...(includeRoom ? [{ channel: "matrix", to: "room:!ops:example.org" }] : []),
    ]);
    expect(
      [allowed, denied].map((senderId) => isMatrixExecApprovalAuthorizedSender({ cfg, senderId })),
    ).toEqual([true, false]);
  });

  const exec = {
    approvalId: "req-1",
    approvalSlug: "req-1",
    agentId: "ops-agent",
    sessionKey: "agent:ops-agent:matrix:channel:!ops:example.org",
  };
  it.each([
    { name: "enabled exec", cfg: buildConfig(enabled), metadata: exec, suppressed: true },
    { name: "disabled exec", cfg: buildConfig(), metadata: exec, suppressed: false },
    {
      name: "plugin with DM approvers",
      cfg: buildConfig(enabled, { dm: { allowFrom: ["@owner:example.org"] } }),
      metadata: { approvalId: "plugin:req-1", approvalSlug: "plugin:r", approvalKind: "plugin" },
      suppressed: true,
    },
  ])("suppresses local prompts for $name: $suppressed", async ({ cfg, metadata, suppressed }) => {
    expect(
      await shouldSuppressLocalMatrixExecApprovalPrompt({
        cfg,
        payload: { channelData: { execApproval: metadata } },
      }),
    ).toBe(suppressed);
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

    await expectEligibility(cfg, request, false);
  });

  it("ignores disabled matrix accounts when checking unbound account eligibility", async () => {
    const cfg = buildMultiAccountMatrixConfig({
      opsOverrides: { enabled: false },
    });
    const request = makeChannelApprovalRequest({
      id: "req-7",
      turnSourceChannel: "matrix",
    });

    await expectEligibility(cfg, request, true);
  });
});
