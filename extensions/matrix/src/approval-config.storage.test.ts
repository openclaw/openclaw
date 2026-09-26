import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const selectionCases = [
  {
    name: "explicit named",
    accountId: "OPS",
    role: "ops",
    matrix: { ...account("default"), accounts: { ops: account("ops") } },
  },
  {
    name: "named default",
    accountId: undefined,
    role: "ops",
    matrix: { ...account("default"), defaultAccount: "ops", accounts: { ops: account("ops") } },
  },
  {
    name: "null default",
    accountId: null,
    role: "ops",
    matrix: { ...account("default"), defaultAccount: "ops", accounts: { ops: account("ops") } },
  },
  {
    name: "sole named",
    accountId: undefined,
    role: "ops",
    matrix: { accounts: { ops: account("ops") } },
  },
  {
    name: "explicit empty",
    accountId: "",
    role: "default",
    matrix: { ...account("default"), defaultAccount: "ops", accounts: { ops: account("ops") } },
  },
];

async function expectNoHostSql(stateDir: string, label: string, run: () => void | Promise<void>) {
  await closeOpenClawStateDatabaseAsync();
  const observation = observeHostDataSql();
  const sql = observation.calls;
  try {
    await run();
    console.log(
      "matrix approval extraction host SQL",
      label,
      sql.map((spy) => spy.mock.calls.length),
    );
    for (const spy of sql) {
      expect(spy).not.toHaveBeenCalled();
    }
  } finally {
    observation.restore();
  }
}

describe("Matrix approval config boundaries", () => {
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

  for (const approvalKind of ["plugin", "exec", "system-agent"] satisfies ChannelApprovalKind[]) {
    it.each(selectionCases)(
      `${approvalKind} actor policy selects $name without credential SQL`,
      async ({ matrix, accountId, role }) => {
        const cfg: CoreConfig = { channels: { matrix } };
        installMatrixTestRuntime({ stateDir, cfg });
        const capability = matrixPlugin.approvalCapability;
        if (!capability?.authorizeActorAction || !capability.getActionAvailabilityState) {
          throw new Error("Matrix approval capability is not registered");
        }
        await expectNoHostSql(stateDir, `${approvalKind}/${role}/${String(accountId)}`, () => {
          const context = { cfg, accountId, action: "approve" as const, approvalKind };
          expect(capability.getActionAvailabilityState?.(context)).toEqual({ kind: "enabled" });
          const expectedRole = approvalKind === "plugin" ? "owner" : "exec";
          const excludedRole = approvalKind === "plugin" ? "exec" : "owner";
          expect(
            capability.authorizeActorAction?.({
              ...context,
              senderId: `@${role}-${expectedRole}:example.org`,
            }),
          ).toEqual({ authorized: true });
          for (const senderId of [
            `@${role}-${excludedRole}:example.org`,
            "@intruder:example.org",
            "@k:example.org",
          ]) {
            expect(capability.authorizeActorAction?.({ ...context, senderId })).toMatchObject({
              authorized: false,
            });
          }
          expect(
            capability.authorizeActorAction?.({ ...context, senderId: "@K:example.org" }),
          ).toEqual({ authorized: true });
        });
      },
    );
  }

  it.each([{ entries: [] }, { entries: ["*"] }])(
    "never grants an arbitrary actor via empty or wildcard-only config %j",
    async ({ entries }) => {
      const cfg: CoreConfig = {
        channels: {
          matrix: {
            ...account("default"),
            dm: { allowFrom: entries },
            execApprovals: { enabled: true, approvers: entries },
          },
        },
      };
      installMatrixTestRuntime({ stateDir, cfg });
      await expectNoHostSql(stateDir, `empty/wildcard ${entries.length}`, () => {
        for (const approvalKind of ["plugin", "exec", "system-agent"] as const) {
          expect(
            matrixPlugin.approvalCapability?.authorizeActorAction?.({
              cfg,
              senderId: "@intruder:example.org",
              action: "approve",
              approvalKind,
            }),
          ).toMatchObject({ authorized: false });
        }
      });
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
      await expectNoHostSql(stateDir, `reaction/${approvalKind}`, async () => {
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
});
