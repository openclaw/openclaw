import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { captureCommandOwnerAssertion } from "../../auto-reply/command-owner-authority.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import {
  SessionWorkStartChangedError,
  SessionWorkStartInvalidatedError,
} from "../../config/sessions/lifecycle.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { loadDeliveryQueueEntries } from "../../infra/delivery-queue-sqlite.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-namespaces.js";
import { drainPendingDeliveriesCore } from "../../infra/outbound/delivery-queue-recovery.js";
import { loadUnfinishedDeliveries as loadPendingDeliveries } from "../../infra/outbound/delivery-queue-storage.js";
import { createRecoveryLog } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../plugin-sdk/test-helpers/contracts-testkit.js";
import {
  stageActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
  publishUserChannelPolicyInDatabase,
  resolveUserChannelAuthorizationPolicy,
} from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { persistPendingFinalDeliveryMarker } from "../pending-final-delivery-marker.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import { deliverAgentCommandResult } from "./delivery.js";

const COMMAND_OWNER_OUTBOUND_DELIVERY_QUEUE_NAME = "outbound-command-owner-v1";
const privatePaths = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock("../../infra/tmp-openclaw-dir.js", () => ({
  DEFAULT_POSIX_TMP_ROOT: "/tmp/openclaw",
  resolvePreferredOpenClawTmpDir: () => {
    if (!privatePaths.root) {
      throw new Error("Private restart-final handoff root is not installed");
    }
    return privatePaths.root;
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  const root = fs.realpathSync(tempDirs.make("openclaw-restart-final-"));
  privatePaths.root = root;
  const databasePath = resolveManagedUpdateLeaseDatabasePath();
  expect(databasePath).toBe(path.join(root, "managed-update-handoffs.sqlite"));
  // Check the physical parent before any executor/config write can open the store.
  expect(fs.realpathSync(path.dirname(databasePath))).toBe(root);
});
afterEach(() => {
  resetPluginRuntimeStateForTest();
  privatePaths.root = undefined;
});

it.each(
  (["onPlatformSendDispatch", "assertDirectAdapterHandoff"] as const).flatMap((handoff) =>
    (
      [
        "restart",
        "restart-configured-allowed",
        "restart-configured-removed",
        "restart-configured-replaced",
        "restart-configured-restored",
        "restart-configured-older-writer",
        "restart-configured-handoff-removed",
        "restart-invalidated",
        "restart-changed",
        "restart-replaced",
        "restart-owner-revoked",
        "restart-owner-retired",
        "revoked",
        "replaced",
        "source-unavailable",
        "restart-retained-owner-revoked",
        "restart-retained-owner-restored",
        "restart-retained-unlinked",
        "restart-retained-relinked",
        "restart-retained-profile-replaced",
        "restart-retained-default-restored",
        "restart-retained-grant-allowed",
        "restart-retained-grant-replaced",
        "restart-retained-grant-handoff-replaced",
        "restart-retained-policy-restored",
        "restart-retained-identity-policy-restored",
        "restart-retained-lifecycle",
        "restart-retained-missing-reference",
        "restart-retained-corrupt-reference",
        "restart-retained-recovered-handoff-revoked",
        "restart-source-unavailable",
        "cancelled",
      ] as const
    ).map((boundary) => ({ handoff, boundary })),
  ),
)(
  "fences $boundary at $handoff and leaves only valid recovery custody",
  async ({ boundary, handoff }) => {
    await withAdminIngress(
      async ({ state, admins, context, cfg, activatePolicy, retire }) => {
        const recover = () =>
          drainPendingDeliveriesCore({
            drainKey: "restart-final",
            logLabel: "Restart final",
            cfg,
            log: createRecoveryLog(),
            stateDir: state.stateDir,
            deliver: deliverOutboundPayloads,
            selectEntry: () => ({ match: true, bypassBackoff: true }),
          });
        const admin = admins[0]!;
        let grantId = "86633673-b1dd-4500-85e2-b6e6e490810f";
        const grantLifetime = new AbortController();
        const grantFixture = boundary.includes("grant-")
          ? createPluginRegistryFixture(cfg)
          : undefined;
        const replaceGrant = () => {
          grantLifetime.abort();
          grantId = "78a7c3d0-c3a6-49a5-91e7-02c153e39ab5";
        };
        if (grantFixture) {
          const { registry, config } = grantFixture;
          registerVirtualTestPlugin({
            registry,
            config,
            id: "final-owner-policy",
            name: "Final owner policy",
            register(api) {
              const current = () => ({
                grantId,
                signal: grantLifetime.signal,
                assertCurrent: () => grantLifetime.signal.throwIfAborted(),
              });
              api.registerGatewayAccessPolicy({
                authorize: current,
                resume: ({ grantId: original }) => (original === grantId ? current() : undefined),
              });
            },
          });
          stageActivePluginRegistry(registry.registry, null, "default");
          const roles = structuredClone(cfg.gateway!.roles!);
          roles.definitions.admin!.accessPolicyPlugin = "final-owner-policy";
          await activatePolicy({ roles });
        }
        if (boundary === "restart-retained-default-restored") {
          setUserProfileRole(admin.profile.id, null);
          await activatePolicy({ roles: { ...cfg.gateway!.roles!, default: "admin" } });
        }

        const configured = boundary.startsWith("restart-configured-");
        if (configured) {
          cfg.commands!.ownerAllowFrom = [admin.identity.senderId, admins[1]!.identity.senderId];
          // Configured command owners do not depend on a profile role or channel link.
          unlinkUserChannelIdentity(admin.profile.id, admin.identity);
          await activatePolicy({});
        }
        const assertOwnerCurrent = captureCommandOwnerAssertion(
          await context(admin.identity.senderId),
        );
        if (!assertOwnerCurrent) {
          throw new Error("Channel owner assertion was not admitted");
        }
        assertOwnerCurrent();
        // Confirm every database selector before the first session/queue write.
        expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        const databasePaths: [string, string][] = [
          [resolveOpenClawStateSqlitePath(), state.statePath("state", "openclaw.sqlite")],
          [
            resolveOpenClawAgentSqlitePath({ agentId: "main" }),
            path.join(state.agentDir(), "openclaw-agent.sqlite"),
          ],
        ];
        for (const [databasePath, expectedPath] of databasePaths) {
          expect(databasePath).toBe(expectedPath);
          fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
          expect(fs.realpathSync(path.dirname(databasePath))).toBe(path.dirname(expectedPath));
        }
        const sessionKey = "agent:main:matrix:direct:restart-final";
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const target = { sessionKey, storePath };
        const entry = {
          sessionId: "restart-final",
          status: "running" as const,
          updatedAt: Date.now(),
        };
        await replaceSessionEntry(target, entry);
        const payloads = [{ text: "Captured final answer" }, { text: "Final detail" }];
        for (const payload of boundary.endsWith("replaced") ? payloads : []) {
          setReplyPayloadMetadata(payload, {
            sessionWriterDeliveryAuthority: {
              agentId: "main",
              sessionKey,
              storePath,
              expectedSessionId: entry.sessionId,
            },
          });
        }
        const marker = await persistPendingFinalDeliveryMarker({
          agentId: "main",
          deliver: true,
          sessionStore: { [sessionKey]: entry },
          sessionKey,
          sessionEntry: entry,
          storePath,
          suppressVisibleSessionEffects: false,
          sessionReboundDuringRun: false,
          payloads,
          deliveryContext: { channel: "matrix", to: "!restart:example" },
          runOwnedSessionId: entry.sessionId,
          commandOwnerReference: assertOwnerCurrent.recoveryReference,
        });
        expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(true);
        const entered = createDeferred();
        const release = createDeferred();
        const writes: string[] = [];
        let held = true;
        const hold = async () => {
          if (held) {
            entered.resolve();
            await release.promise;
          } else if (boundary === "restart-retained-recovered-handoff-revoked") {
            setUserProfileRole(admin.profile.id, "member");
          } else if (boundary === "restart-retained-grant-handoff-replaced") {
            replaceGrant();
          } else if (boundary === "restart-configured-handoff-removed") {
            cfg.commands!.ownerAllowFrom = [];
            await activatePolicy({});
          }
        };
        const channelRegistry = createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: {
              ...createOutboundTestPlugin({
                id: "matrix",
                outbound: {
                  deliveryMode: "direct",
                  sendText: async () => {
                    throw new Error("message adapter owns send");
                  },
                },
              }),
              message: {
                id: "matrix",
                durableFinal: { capabilities: { text: true } },
                send: {
                  text: async ({
                    text,
                    onPlatformSendDispatch,
                    assertDirectAdapterHandoff,
                  }: ChannelMessageSendTextContext) => {
                    if (handoff === "onPlatformSendDispatch") {
                      await hold();
                    }
                    await onPlatformSendDispatch?.();
                    if (handoff === "assertDirectAdapterHandoff") {
                      await hold();
                    }
                    assertDirectAdapterHandoff?.();
                    writes.push(text);
                    const messageId = `delivered-final-${writes.length}`;
                    return {
                      messageId,
                      receipt: createMessageReceiptFromOutboundResults({
                        results: [{ channel: "matrix", messageId }],
                        kind: "text",
                      }),
                    };
                  },
                },
              },
            },
          },
        ]);
        if (grantFixture) {
          grantFixture.registry.registry.channels.push(...channelRegistry.channels);
          setActivePluginRegistry(grantFixture.registry.registry);
        } else {
          setActivePluginRegistry(channelRegistry);
        }
        const controller = new AbortController();
        let custodyError: Error | undefined;
        const delivery = deliverAgentCommandResult({
          cfg,
          deps: {},
          runtime: { log: () => {}, error: () => {}, exit: () => {} },
          opts: {
            message: "continue",
            deliver: true,
            bestEffortDeliver: true,
            replyChannel: "matrix",
            replyTo: "!restart:example",
            sessionKey,
            runId: "recovery-run",
            abortSignal: controller.signal,
          },
          outboundSession: { agentId: "main", key: sessionKey },
          sessionEntry: marker.sessionEntry,
          result: { meta: { durationMs: 1 } },
          payloads,
          assertDeliveryCurrent: () => {
            assertOwnerCurrent();
            if (custodyError) {
              throw custodyError;
            }
            controller.signal.throwIfAborted();
          },
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          await Promise.race([
            entered.promise,
            delivery.then((settled) => {
              throw new Error("sender settled before preparation", { cause: settled });
            }),
          ]);
          // The real sender has admitted custody before either adapter callback.
          expect(await loadPendingDeliveries(state.stateDir)).toHaveLength(1);
          const captured = loadSessionEntry(target)!;
          const replaced = boundary === "replaced" || boundary === "restart-replaced";
          await replaceSessionEntry(target, {
            ...captured,
            abortedLastRun: true,
            ...(replaced ? { sessionId: "replacement-session" } : {}),
          });
          const restarting = boundary.startsWith("restart");
          const ownerRevoked = boundary === "restart-owner-revoked";
          const sourceUnavailable =
            boundary === "source-unavailable" || boundary === "restart-source-unavailable";
          const lateRevocation = boundary.startsWith("restart-retained-owner-");
          const recoverable =
            restarting &&
            !sourceUnavailable &&
            boundary !== "restart-changed" &&
            !replaced &&
            !ownerRevoked;
          if (ownerRevoked) {
            setUserProfileRole(admin.profile.id, "member");
            expect(assertOwnerCurrent).toThrow("Channel operator authority changed");
          }
          if (boundary === "restart-owner-retired") {
            retire();
          }
          if (restarting) {
            controller.abort(createAgentRunRestartAbortError());
          }
          if (sourceUnavailable) {
            custodyError = new Error("Source session read unavailable");
          } else if (boundary === "cancelled") {
            controller.abort(new Error("Operator cancelled the run"));
          } else if (
            boundary !== "restart" &&
            boundary !== "restart-owner-retired" &&
            !boundary.startsWith("restart-retained-") &&
            !configured &&
            !ownerRevoked
          ) {
            custodyError =
              boundary === "revoked" || boundary === "restart-invalidated"
                ? new SessionWorkStartInvalidatedError("Source admission invalidated")
                : new SessionWorkStartChangedError("Source admission changed");
          }
          release.resolve();
          await delivery;
          expect(writes).toEqual([]);
          // Concurrent replacement may reject now or at recovery, but must never send.
          if (!replaced) {
            expect
              .soft(await loadPendingDeliveries(state.stateDir))
              .toHaveLength(recoverable || (restarting && ownerRevoked) ? 1 : 0);
          }
          if (boundary === "restart-configured-allowed") {
            // Membership is set-like: order, duplicate entries, and outer whitespace do not revoke.
            cfg.commands!.ownerAllowFrom = [
              admins[1]!.identity.senderId,
              ` ${admin.identity.senderId} `,
              admin.identity.senderId,
            ];
            setUserProfileRole(admin.profile.id, "member");
            const roles = structuredClone(cfg.gateway!.roles!);
            roles.definitions.admin!.scopes = ["operator.read"];
            await activatePolicy({ roles });
          } else if (boundary === "restart-configured-older-writer") {
            // A schema-19 predecessor publishes only these facts, replacing the whole JSON row.
            runOpenClawStateWriteTransaction(({ db }) =>
              publishUserChannelPolicyInDatabase(
                db,
                resolveUserChannelAuthorizationPolicy(cfg.gateway),
              ),
            );
            await activatePolicy({});
          } else if (configured && boundary !== "restart-configured-handoff-removed") {
            cfg.commands!.ownerAllowFrom =
              boundary === "restart-configured-replaced" ? [admins[1]!.identity.senderId] : [];
            await activatePolicy({});
            if (boundary === "restart-configured-restored") {
              cfg.commands!.ownerAllowFrom = [admin.identity.senderId];
              await activatePolicy({});
            }
          }
          if (lateRevocation) {
            setUserProfileRole(admin.profile.id, "member");
            if (boundary.endsWith("restored")) {
              setUserProfileRole(admin.profile.id, "admin");
            }
            expect(assertOwnerCurrent).toThrow("Channel operator authority changed");
          }
          if (
            boundary === "restart-retained-unlinked" ||
            boundary === "restart-retained-relinked" ||
            boundary === "restart-retained-profile-replaced"
          ) {
            unlinkUserChannelIdentity(admin.profile.id, admin.identity);
            if (boundary !== "restart-retained-unlinked") {
              linkUserChannelIdentity(
                boundary === "restart-retained-profile-replaced"
                  ? admins[1]!.profile.id
                  : admin.profile.id,
                admin.identity,
              );
            }
          }
          if (boundary === "restart-retained-grant-replaced") {
            replaceGrant();
          }
          if (
            boundary === "restart-retained-policy-restored" ||
            boundary === "restart-retained-default-restored"
          ) {
            const original = structuredClone(cfg.gateway!.roles!);
            const changed = structuredClone(original);
            if (boundary === "restart-retained-default-restored") {
              changed.default = "member";
            } else {
              changed.definitions.admin!.scopes = ["operator.read"];
            }
            await activatePolicy({ roles: changed });
            await activatePolicy({ roles: original });
          }
          if (boundary === "restart-retained-identity-policy-restored") {
            const original = structuredClone(cfg.gateway!.auth!);
            await activatePolicy({ auth: { ...original, identityScopes: undefined } });
            await activatePolicy({ auth: original });
          }
          if (boundary.endsWith("reference")) {
            const db = openOpenClawStateDatabase().db;
            db.prepare(
              boundary === "restart-retained-missing-reference"
                ? "UPDATE delivery_queue_entries SET entry_json = json_remove(entry_json, '$.deliveryCompletion.commandOwnerReference') WHERE queue_name = ?"
                : "UPDATE delivery_queue_entries SET entry_json = json_set(entry_json, '$.deliveryCompletion.commandOwnerReference.id', 'corrupt') WHERE queue_name = ?",
            ).run(COMMAND_OWNER_OUTBOUND_DELIVERY_QUEUE_NAME);
          }
          // Capture older executors' inventory before recovery consumes this intent.
          const olderQueueRows = recoverable
            ? [
                ...loadDeliveryQueueEntries(OUTBOUND_DELIVERY_QUEUE_NAME, state.stateDir),
                ...loadDeliveryQueueEntries("outbound-session-generation-v1", state.stateDir),
              ]
            : [];
          const markerKind = loadSessionEntry(target)?.pendingFinalDelivery?.kind;
          if (boundary === "restart-retained-lifecycle") {
            await closeOpenClawStateDatabaseAsync();
          }
          const mayRecover =
            recoverable &&
            (!configured || boundary === "restart-configured-allowed") &&
            (!boundary.startsWith("restart-retained-") ||
              boundary === "restart-retained-lifecycle" ||
              boundary === "restart-retained-grant-allowed");
          held = false;
          await recover();
          if (
            boundary === "restart-retained-recovered-handoff-revoked" ||
            boundary === "restart-configured-handoff-removed"
          ) {
            expect(writes).toEqual([]);
            expect(await loadPendingDeliveries(state.stateDir)).toHaveLength(1);
            await recover();
          }
          expect(writes).toEqual(mayRecover ? ["Captured final answer", "Final detail"] : []);
          expect(await loadPendingDeliveries(state.stateDir)).toHaveLength(0);
          if (recoverable) {
            expect(olderQueueRows).toHaveLength(0);
            expect(markerKind).toBe("transport-only");
          }
          if (mayRecover) {
            expect(loadSessionEntry(target)?.pendingFinalDelivery?.deliveries).toEqual([
              { id: expect.any(String), state: "delivered" },
            ]);
          }
          // Re-enter recovery after settlement; neither success nor revocation may replay.
          await recover();
          expect(writes).toEqual(mayRecover ? ["Captured final answer", "Final detail"] : []);
        } finally {
          controller.abort();
          release.resolve();
          await delivery;
        }
      },
      boundary === "restart-retained-identity-policy-restored" ? "identity-grant" : "role",
    );
  },
);
