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
import { matrixApprovalCapability as capability } from "./approval-native.js";
import {
  getMatrixExecApprovalApprovers as approvers,
  isMatrixExecApprovalAuthorizedSender as isAuthorized,
  isMatrixApprovalClientEnabled as isEnabled,
  resolveMatrixExecApprovalTarget as targetFor,
  shouldHandleMatrixApprovalRequest as handles,
  shouldSuppressLocalMatrixExecApprovalPrompt as suppressPrompt,
} from "./exec-approvals.js";
import type { MatrixAccountConfig } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync(sessionRoot);
    cleanup();
  });
});
const sessionRoot = tempDirs.make("openclaw-matrix-exec-approvals-");
const enabled = { enabled: true, approvers: ["@owner:example.org"] };
const context = { accountId: "default", action: "approve" as const };
const account = (
  id: string,
  overrides: Partial<MatrixAccountConfig> = {},
): MatrixAccountConfig => ({
  homeserver: "https://matrix.example.org",
  userId: "@bot-" + id + ":example.org",
  accessToken: "tok-" + id,
  ...overrides,
});
function config(
  execApprovals?: MatrixAccountConfig["execApprovals"],
  allowFrom?: string[],
): OpenClawConfig {
  const matrix = account("default", { execApprovals, ...(allowFrom ? { dm: { allowFrom } } : {}) });
  return { channels: { matrix } } as OpenClawConfig;
}
function multiConfig(store?: string, ops: Partial<MatrixAccountConfig> = {}): OpenClawConfig {
  const accounts = {
    default: account("default", { execApprovals: enabled }),
    ops: account("ops", { ...ops, execApprovals: enabled }),
  };
  return {
    channels: { matrix: { accounts } },
    ...(store ? { session: { store } } : {}),
  } as OpenClawConfig;
}
const makeRequest = <T>(request: T, id: string) => ({
  id,
  request,
  createdAtMs: 0,
  expiresAtMs: 1000,
});
function channelRequest(id: string, overrides: Partial<ExecApprovalRequest["request"]> = {}) {
  return makeRequest(
    {
      command: "echo hi",
      agentId: "ops-agent",
      sessionKey: "agent:ops-agent:missing",
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C123",
      ...overrides,
    },
    id,
  );
}
async function expectEligibility(
  cfg: OpenClawConfig,
  request: ExecApprovalRequest,
  defaultEnabled: boolean,
) {
  const check = (accountId: string) => handles({ cfg, accountId, request, approvalKind: "exec" });
  expect(await check("default")).toBe(defaultEnabled);
  expect(await check("ops")).toBe(!defaultEnabled);
}
const authorization = (cfg: OpenClawConfig, ...senders: string[]) =>
  senders.map((senderId) => isAuthorized({ cfg, senderId }));

describe("matrix exec approvals", () => {
  it("prefers explicit approvers when configured", () => {
    const cfg = config({ enabled: true, approvers: ["user:@override:example.org"] }, [
      "@owner:example.org",
    ]);
    expect(approvers({ cfg })).toEqual(["@override:example.org"]);
    expect(authorization(cfg, "@override:example.org", "@owner:example.org")).toEqual([
      true,
      false,
    ]);
  });

  it("ignores wildcard allowlist entries when inferring exec approvers", async () => {
    const cfg = config({ enabled: true }, ["*"]);
    expect(approvers({ cfg })).toStrictEqual([]);
    expect(await isEnabled({ approvalKind: "exec", cfg })).toBe(false);
  });

  it("defaults target to dm", () => {
    expect(targetFor({ cfg: config(enabled) })).toBe("dm");
  });

  it.each([
    ["@target:example.org", "@other:example.org", true],
    ["@K:example.org", "@k:example.org", false],
  ] as const)("matches exact forwarding recipient %s", (allowed, denied, includeRoom) => {
    const targets = [
      { channel: "matrix", to: "user:" + allowed },
      ...(includeRoom ? [{ channel: "matrix", to: "room:!ops:example.org" }] : []),
    ];
    const cfg = {
      ...config(),
      approvals: { exec: { enabled: true, mode: "targets" as const, targets } },
    };
    expect(authorization(cfg, allowed, denied)).toEqual([true, false]);
  });

  const exec = {
    approvalId: "req-1",
    approvalSlug: "req-1",
    agentId: "ops-agent",
    sessionKey: "agent:ops-agent:matrix:channel:!ops:example.org",
  };
  it.each([
    { name: "enabled exec", cfg: config(enabled), metadata: exec, suppressed: true },
    { name: "disabled exec", cfg: config(), metadata: exec, suppressed: false },
    {
      name: "plugin with DM approvers",
      cfg: config(enabled, ["@owner:example.org"]),
      metadata: { approvalId: "plugin:req-1", approvalSlug: "plugin:r", approvalKind: "plugin" },
      suppressed: true,
    },
  ])("suppresses local prompts for $name: $suppressed", async ({ cfg, metadata, suppressed }) => {
    const payload = { channelData: { execApproval: metadata } };
    expect(await suppressPrompt({ cfg, payload })).toBe(suppressed);
  });

  it("scopes non-matrix turn sources to the stored matrix account", async () => {
    const storePath = path.join(tempDirs.make("case-", sessionRoot), "sessions.json");
    const sessionKey = "agent:ops-agent:matrix:channel:!room:example.org";
    const destination = { accountId: "ops", to: "room:!room:example.org" };
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "main",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          origin: { provider: "matrix", ...destination, nativeChannelId: "!room:example.org" },
          context: { channel: "matrix", ...destination },
        }),
      },
    });
    await expectEligibility(multiConfig(storePath), channelRequest("req-3", { sessionKey }), false);
  });

  it("ignores disabled matrix accounts when checking unbound account eligibility", async () => {
    await expectEligibility(
      multiConfig(undefined, { enabled: false }),
      channelRequest("req-7", { turnSourceChannel: "matrix" }),
      true,
    );
  });
});

const execRequest = makeRequest({ command: "echo hi" }, "opaque-exec-approval-id");
const pluginRequest = makeRequest(
  {
    title: "Plugin Approval Required",
    description: "Allow plugin access",
    pluginId: "git-tools",
    turnSourceChannel: "matrix",
    turnSourceTo: "room:!ops:example.org",
  },
  "opaque-approval-id",
);
const { nativeAsync: native, nativeRuntimeAsync: runtime, delivery } = capability;
const configured = config({ ...enabled, target: "both" });
const nativeContext = (cfg = configured, approvalKind: "exec" | "plugin" = "exec") => ({
  ...context,
  cfg,
  approvalKind,
  request: approvalKind === "exec" ? execRequest : pluginRequest,
});

describe("matrix approval capability", () => {
  it("keeps plugin approval auth independent from exec approvers", async () => {
    const cfg = config({ enabled: true, approvers: ["@exec:example.org"], target: "both" }, [
      "@owner:example.org",
    ]);
    const authorize = (senderId: string, approvalKind: "plugin" | "exec") =>
      capability.authorizeActorActionAsync?.({ ...context, cfg, senderId, approvalKind });

    expect(await authorize("@owner:example.org", "plugin")).toEqual({ authorized: true });
    expect(await authorize("@exec:example.org", "plugin")).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Matrix.",
    });
    expect(await authorize("@exec:example.org", "exec")).toEqual({ authorized: true });
  });

  it.each([undefined, "work"])("describes the Matrix setup path for account %s", (accountId) => {
    const text = capability.describeExecApprovalSetup?.({
      channel: "matrix",
      channelLabel: "Matrix",
      accountId,
    });
    const prefix = accountId ? "channels.matrix.accounts.work" : "channels.matrix";
    expect(text).toContain("`" + prefix + ".execApprovals.approvers`");
    expect(text).toContain("`" + prefix + ".dm.allowFrom`");
    if (accountId) {
      expect(text).not.toContain("`channels.matrix.execApprovals.approvers`");
    } else {
      expect(text).toContain("Approve it from the Web UI for now.");
      expect(text).not.toMatch(/terminal UI|\bTUI\b/i);
    }
  });

  it("resolves approver dm targets", async () => {
    expect(await native?.resolveApproverDmTargets?.(nativeContext())).toEqual([
      { to: "user:@owner:example.org" },
    ]);
  });

  it("requires Matrix DM approvers before enabling plugin approval auth", async () => {
    const cfg = config({ enabled: true, approvers: ["@exec:example.org"], target: "both" }, []);
    const action = {
      ...context,
      cfg,
      senderId: "@exec:example.org",
      approvalKind: "plugin" as const,
    };
    expect(await capability.authorizeActorActionAsync?.(action)).toEqual({
      authorized: false,
      reason: "❌ Matrix plugin approvals are not enabled for this bot account.",
    });
  });

  it("reports exec initiating-surface availability independently from plugin auth", async () => {
    const cfg = config({ enabled: false, approvers: [], target: "both" }, ["@owner:example.org"]);
    const action = { ...context, cfg, approvalKind: "plugin" as const };
    expect(capability.getActionAvailabilityState?.(action)).toEqual({ kind: "enabled" });
    expect(await capability.getExecInitiatingSurfaceStateAsync?.({ cfg, ...context })).toEqual({
      kind: "disabled",
    });
  });

  it("handles opaque-id plugin approvals for plugin-only approvers", async () => {
    const cfg = config({ enabled: true, approvers: [], target: "both" }, ["*"]);
    const plugin = nativeContext(cfg, "plugin");
    const missingKind = { ...context, cfg, request: pluginRequest };
    expect(await runtime?.availability.shouldHandle(plugin)).toBe(true);
    expect((await native?.describeDeliveryCapabilities(plugin))?.enabled).toBe(true);
    expect(await native?.resolveOriginTarget?.(plugin)).toEqual({
      to: "room:!ops:example.org",
      threadId: undefined,
    });
    expect(await native?.resolveOriginTarget?.(missingKind as never)).toBeNull();
    expect(
      await runtime?.availability.shouldHandle({ ...missingKind, cfg: configured } as never),
    ).toBe(false);
    const target = { channel: "matrix", to: "room:!ops:example.org", accountId: "default" };
    expect(
      await delivery?.shouldSuppressForwardingFallbackAsync?.({ ...plugin, target } as never),
    ).toBe(true);
    expect(await runtime?.availability.shouldHandle(nativeContext(cfg))).toBe(false);
  });

  it("keeps matrix-native plugin approval delivery disabled without DM approvers", async () => {
    expect(await native?.describeDeliveryCapabilities(nativeContext(configured, "plugin"))).toEqual(
      {
        enabled: false,
        preferredSurface: "both",
        supportsOriginSurface: true,
        supportsApproverDmSurface: true,
        notifyOriginWhenDmOnly: true,
      },
    );
  });
});
