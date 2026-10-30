import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { unregisterMatrixApprovalReactionTarget } from "./approval-reactions.js";
import { matrixPlugin } from "./channel.js";
import { openMatrixCredentialsStore } from "./matrix/credentials-read.js";
import { handleInboundMatrixReaction } from "./matrix/monitor/reaction-events.js";
import { MatrixClient } from "./matrix/sdk.js";
import { getMatrixRuntime } from "./runtime.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig, MatrixAccountConfig } from "./types.js";

const gateway = vi.hoisted(() => ({ resolve: vi.fn(), edit: vi.fn() }));
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: gateway.resolve,
}));
vi.mock("./matrix/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./matrix/send.js")>()),
  editMessageMatrix: gateway.edit,
}));

function account(role: string): MatrixAccountConfig {
  return {
    homeserver: "https://matrix.example.org",
    userId: `@${role}-bot:example.org`,
    accessToken: `synthetic-${role}-token`,
    reactionNotifications: "off",
    dm: { allowFrom: [`matrix:@${role}-owner:example.org`, "@K:example.org", "*"] },
    execApprovals: {
      enabled: true,
      approvers: [`user:@${role}-exec:example.org`, "@K:example.org", "*"],
    },
  };
}

const namedAccounts = { ops: account("ops") };
const namedDefault = { ...account("default"), defaultAccount: "ops", accounts: namedAccounts };
type ApprovalKind = "plugin" | "exec" | "system-agent";
type MatrixConfig = NonNullable<CoreConfig["channels"]>["matrix"];
const selectionCases: [string, ApprovalKind, string | null | undefined, MatrixConfig, string][] = [
  ["explicit named", "plugin", "OPS", { ...account("default"), accounts: namedAccounts }, "ops"],
  ["named default", "exec", undefined, namedDefault, "ops"],
  ["null default", "system-agent", null, namedDefault, "ops"],
  ["sole named", "plugin", undefined, { accounts: namedAccounts }, "ops"],
  ["explicit empty", "exec", "", namedDefault, "default"],
];

async function expectNoHostSql(run: () => void | Promise<void>) {
  await closeOpenClawStateDatabaseAsync();
  const observation = observeHostDataSql();
  try {
    await run();
    for (const spy of observation.calls) {
      expect(spy).not.toHaveBeenCalled();
    }
  } finally {
    observation.restore();
  }
}

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
let stateDir: string;
const targets: Parameters<typeof unregisterMatrixApprovalReactionTarget>[0][] = [];
const clients: MatrixClient[] = [];
beforeAll(() => {
  stateDir = tempDirs.make("matrix-approval-config-");
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MATRIX_")) {
      vi.stubEnv(key, undefined);
    }
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  installMatrixTestRuntime({ stateDir });
  openMatrixCredentialsStore().register("account:default", {
    accountId: "default",
    homeserver: "https://matrix.example.org",
    userId: "@default-bot:example.org",
    accessToken: "synthetic-persisted-token",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
});
beforeEach(() => {
  gateway.resolve.mockReset().mockResolvedValue({
    applied: true,
    approval: { id: "synthetic-approval", status: "allowed", decision: "allow-once" },
  });
  gateway.edit.mockReset().mockResolvedValue("$edited");
});
afterEach(async () => {
  for (const target of targets.splice(0)) {
    await unregisterMatrixApprovalReactionTarget(target);
  }
  for (const client of clients.splice(0)) {
    await client.stopWithoutPersist();
  }
  await closeOpenClawStateDatabaseAsync();
});

async function expectPolicy(
  matrix: MatrixConfig,
  accountId: string | null | undefined,
  approvalKind: ApprovalKind,
  allowed: string[],
  denied: string[],
) {
  const cfg: CoreConfig = { channels: { matrix } };
  installMatrixTestRuntime({ stateDir, cfg });
  const { authorizeActorActionAsync: authorize, getActionAvailabilityState: available } =
    matrixPlugin.approvalCapability!;
  const context = { cfg, accountId, action: "approve" as const, approvalKind };
  await expectNoHostSql(async () => {
    if (allowed.length) {
      expect(available!(context)).toEqual({ kind: "enabled" });
    }
    for (const senderId of allowed) {
      expect(await authorize!({ ...context, senderId })).toEqual({
        authorized: true,
      });
    }
    for (const senderId of denied) {
      expect(await authorize!({ ...context, senderId })).toMatchObject({ authorized: false });
    }
  });
}

it.each(selectionCases)(
  "%s %s actor policy selects config without credential SQL",
  async (_name, approvalKind, accountId, matrix, role) => {
    const expectedRole = approvalKind === "plugin" ? "owner" : "exec";
    const excludedRole = approvalKind === "plugin" ? "exec" : "owner";
    await expectPolicy(
      matrix,
      accountId,
      approvalKind,
      [`@${role}-${expectedRole}:example.org`, "@K:example.org"],
      [`@${role}-${excludedRole}:example.org`, "@intruder:example.org", "@k:example.org"],
    );
  },
);

it.each([{ entries: [] }, { entries: ["*"] }])(
  "never grants an arbitrary actor via empty or wildcard-only config %j",
  async ({ entries }) => {
    const matrix = {
      ...account("default"),
      dm: { allowFrom: entries },
      execApprovals: { enabled: true, approvers: entries },
    };
    for (const approvalKind of ["plugin", "exec", "system-agent"] as const) {
      await expectPolicy(matrix, undefined, approvalKind, [], ["@intruder:example.org"]);
    }
  },
);

it.each(["exec", "plugin"] as const)(
  "authorizes %s reactions against a persisted anchor without credential SQL",
  async (approvalKind) => {
    const cfg: CoreConfig = { channels: { matrix: { accounts: { ops: account("ops") } } } };
    installMatrixTestRuntime({ stateDir, cfg });
    const target = {
      accountId: "ops",
      roomId: "!approvals:example.org",
      eventId: `$approval-${approvalKind}`,
    };
    targets.push(target);
    const key = JSON.stringify([target.accountId, target.roomId, target.eventId]);
    const store = getMatrixRuntime().state.openKeyedStore({
      namespace: "matrix.approval-reactions",
      maxEntries: 1000,
      defaultTtlMs: 24 * 60 * 60 * 1000,
    });
    const record = {
      version: 1,
      target: {
        ...target,
        approvalId: "synthetic-approval",
        approvalKind,
        allowedDecisions: ["allow-once"],
      },
    };
    // Seed the durable representation directly so the first lookup cannot use the in-memory index.
    await store.register(key, record, { ttlMs: 60_000 });
    const client = new MatrixClient("https://matrix.example.org", "synthetic-client-token", {
      userId: "@ops-bot:example.org",
    });
    clients.push(client);
    const react = (senderId: string) =>
      handleInboundMatrixReaction({
        client,
        core: getMatrixRuntime(),
        cfg,
        accountId: "ops",
        roomId: target.roomId,
        event: {
          type: "m.reaction",
          event_id: "$reaction",
          origin_server_ts: 1,
          sender: senderId,
          content: {
            "m.relates_to": { rel_type: "m.annotation", event_id: target.eventId, key: "✅" },
          },
        },
        senderId,
        senderLabel: senderId,
        selfUserId: "@ops-bot:example.org",
        isDirectMessage: false,
        logVerboseMessage: () => {},
      });
    await expectNoHostSql(async () => {
      await react("@intruder:example.org");
      expect(gateway.resolve).not.toHaveBeenCalled();
      expect(await store.lookup(key)).toEqual(record);
      const senderId =
        approvalKind === "plugin" ? "@ops-owner:example.org" : "@ops-exec:example.org";
      await react(senderId);
      expect(gateway.resolve).toHaveBeenCalledExactlyOnceWith({
        cfg,
        approvalId: "synthetic-approval",
        approvalKind,
        decision: "allow-once",
        channel: "matrix",
        accountId: "ops",
        senderId,
      });
      expect(await store.lookup(key)).toBeUndefined();
      expect(gateway.edit).toHaveBeenCalledOnce();
    });
  },
);
