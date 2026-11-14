import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { retainPreparedSessionSharingFacts } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { readSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createMentionInbox } from "../../gateway/mention-inbox.js";
import type { GatewayClient } from "../../gateway/server-methods/client-types.js";
import {
  gatewayConnect,
  gatewayProfile,
} from "../../gateway/server/client-fixtures.test-support.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  attachRuntimeUserTurnTranscriptRecorder,
  withCurrentRuntimeUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript-runtime-context.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { unwrapSessionManagerPublication } from "./session-manager-publication.js";
import { withSelectedTranscriptReader } from "./session-manager-reader.test-support.js";
import { SessionManager } from "./session-manager.js";

it.each([
  { retainActor: false, revoke: false },
  { retainActor: true, revoke: false },
  { retainActor: false, revoke: true },
  { retainActor: true, revoke: true },
])(
  "commits only current mention authority (actor: $retainActor, revoke: $revoke)",
  async ({ retainActor, revoke }) => {
    await withOpenClawTestState(
      { label: "manager-mention-authority", prepareProfileCatalog: true },
      async (state) => {
        const alice = ensureProfileForEmail("alice@manager-authority.example.test");
        const bob = ensureProfileForEmail("bob@manager-authority.example.test");
        const carol = ensureProfileForEmail("carol@manager-authority.example.test");
        setUserProfileRole(alice.id, "administrator");
        setUserProfileRole(bob.id, "guest");
        const cfg: OpenClawConfig = {
          gateway: {
            roles: {
              default: "staff",
              definitions: {
                administrator: {
                  agents: "*",
                  scopes: ["operator.admin"],
                  sessions: { others: "write" },
                },
                staff: {
                  agents: "*",
                  scopes: ["operator.read", "operator.write"],
                  sessions: { others: "write" },
                },
                guest: {
                  agents: "*",
                  scopes: ["operator.sessions.read", "operator.sessions.write"],
                  sessions: { others: "invited" },
                },
              },
            },
          },
        };
        const client: GatewayClient = {
          connect: gatewayConnect(["operator.admin"]),
          authenticatedUserProfile: gatewayProfile(alice.id, "Alice"),
        };
        const inbox = createMentionInbox({
          scheduler: createTestGatewayScheduler(),
          gatewayInstanceId: "manager-mention-authority",
          getRuntimeConfig: () => cfg,
          getClients: () => [client],
          broadcastToConnIds: vi.fn(),
        });
        await using cleanup = new AsyncDisposableStack();
        cleanup.defer(() => inbox.dispose());
        const target = {
          agentId: "main",
          sessionId: "mention-authority",
          sessionKey: "agent:main:mention-authority",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        // Demotion must not leave Alice authorized through session ownership.
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: carol.id },
        });
        await withSelectedTranscriptReader(
          target,
          async () => {
            const manager = await SessionManager.openAsync(target, state.workspaceDir);
            // Establish the independent session header before taking rollback snapshots.
            await manager.appendMessageAsync({
              role: "user",
              content: "Existing context",
              timestamp: 0,
            });
            const before = await readSessionMembersInWorker(target);
            const beforeEvents = await loadTranscriptEvents(target);
            const beforeEntries = manager.getPersistedEntries();
            const databaseIdentity = readDatabasePathIdentitySync(target.storePath).key;
            const retained = retainPreparedSessionSharingFacts({
              databaseIdentity,
              sessionKey: target.sessionKey,
              entry: before.entry,
              membership: new Set(before.members.map((member) => member.identityId)),
            });
            const acquiring = retainPreparedSessionSharingFacts({
              databaseIdentity,
              sessionKey: target.sessionKey,
              acquiring: true,
            });
            try {
              expect(before.members).toEqual([]);
              const message = {
                role: "user" as const,
                timestamp: 1,
                idempotencyKey: "mention-authority:user",
                content: "@Bob please review",
                __openclaw: { humanMentions: [{ profileId: bob.id, start: 0, end: 4 }] },
              };
              const recorder = createUserTurnTranscriptRecorder({
                target: { ...target, sessionEntry: before.entry },
                message,
                prepareMentionInvitation: () =>
                  expectDefined(
                    inbox.prepareInvitation(
                      client,
                      {
                        agentId: target.agentId,
                        sessionKey: target.sessionKey,
                        entry: before.entry,
                      },
                      [{ profileId: bob.id, token: "@Bob" }],
                    ),
                    "Expected a real administrator invitation",
                  ),
              });
              attachRuntimeUserTurnTranscriptRecorder(message, recorder);
              let revoked = false;
              using _ = probe.admission(workerAdmission, (request, grant, admit) => {
                const { facts } = unwrapSessionManagerPublication(request);
                let publication: unknown =
                  isRecord(facts) && facts.kind === "session-message"
                    ? facts
                    : isRecord(facts)
                      ? facts.publication
                      : undefined;
                if (isRecord(publication) && publication.kind === "session-actor-admission") {
                  publication = publication.final === true ? publication.publication : undefined;
                }
                if (isRecord(publication) && publication.kind === "session-actor-outcome") {
                  publication = publication.publication;
                }
                if (
                  revoke &&
                  !revoked &&
                  request.stage === "commit" &&
                  isRecord(publication) &&
                  publication.kind === "session-message" &&
                  publication.check === "fresh"
                ) {
                  revoked = true;
                  setUserProfileRole(alice.id, "staff");
                }
                admit(request, grant);
              });
              const append = withCurrentRuntimeUserTurnTranscriptRecorder(
                message,
                (beforeFreshMessageCommit) =>
                  manager.appendMessageAsync(message, { beforeFreshMessageCommit }),
              );
              if (revoke) {
                await expect(append).rejects.toMatchObject({
                  name: "MessageInjectionAuthorityError",
                  message: "Message injection authority is no longer current",
                  // Actor failure serialization preserves name/message, not the nested cause.
                  ...(!retainActor
                    ? {
                        cause: expect.objectContaining({
                          message:
                            "Mention invitation authority changed before the message was posted",
                        }),
                      }
                    : {}),
                });
                expect(revoked).toBe(true);
              } else {
                await expect(append).resolves.toBeTypeOf("string");
              }
              // Observe existing readers before a fresh DB read could repair their facts.
              expect(retained.readCurrent()?.membership.has(bob.id)).toBe(!revoke);
              expect(
                acquiring
                  .initialize({ entry: before.entry, membership: new Set() })
                  .membership.has(bob.id),
              ).toBe(!revoke);
              const members = (await readSessionMembersInWorker(target)).members;
              if (revoke) {
                expect(manager.getPersistedEntries()).toEqual(beforeEntries);
                expect(await loadTranscriptEvents(target)).toEqual(beforeEvents);
                expect(members).toEqual([]);
                expect(
                  loadSessionEntry(target)?.profileInvolvement?.profiles[bob.id],
                ).toBeUndefined();
              } else {
                expect(members).toEqual([
                  expect.objectContaining({ identityId: bob.id, addedBy: alice.id }),
                ]);
                expect(await loadTranscriptEvents(target)).toContainEqual(
                  expect.objectContaining({ message }),
                );
              }
            } finally {
              retained.release();
              acquiring.release();
            }
          },
          retainActor,
        );
      },
    );
  },
);
