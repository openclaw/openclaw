import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  getCliHistoryWriter,
  runWithCliHistoryWriter,
} from "../../config/sessions/cli-history-boundary.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { readActiveTranscriptEntryAnchor } from "../../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { appendTranscriptEventSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import {
  getOwnedSessionTranscriptWriterFence,
  runWithoutOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { persistCliSessionBindingResult } from "../cli-session-store.js";
import { claimAgentSessionWriter } from "../embedded-agent-runner/run/session-bootstrap.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../sessions/session-manager.js";
import { persistCliAssistantTranscript } from "./cli-run-transcript.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import { buildCliSessionHistoryPrompt, loadCliSessionPromptContext } from "./session-history.js";
import type { PreparedCliRunContext } from "./types.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "cli-history-boundary-");
afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture(withHeader = true) {
  const dir = sessionDirs.make();
  const target = {
    agentId: "main",
    sessionId: "history",
    sessionKey: "agent:main:history",
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  if (withHeader) {
    appendTranscriptEventSync(target, {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: target.sessionId,
      cwd: dir,
      timestamp: new Date(0).toISOString(),
    });
  }
  const manager = () => SessionManager.open(target, dir);
  let runNumber = 0;
  const withRun = async <T>(
    runId: string,
    action: (params: PreparedCliRunContext["params"]) => Promise<T>,
    overrides: Partial<PreparedCliRunContext["params"]> = {},
  ) => {
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "history-test");
    try {
      return await action({
        admittedRunContext: await admission.admit("embedded"),
        runId,
        agentId: target.agentId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionFile: target.sessionKey,
        sessionTarget: target,
        storePath: target.storePath,
        provider: "test-cli",
        model: "test-model",
        prompt: "current ask",
        workspaceDir: dir,
        timeoutMs: 1000,
        ...overrides,
      });
    } finally {
      admission.close();
    }
  };
  const run = async <T>(
    epoch: string | undefined,
    action: (allowed: boolean, params: PreparedCliRunContext["params"]) => Promise<T>,
    overrides: Partial<PreparedCliRunContext["params"]> = {},
    credential?: AuthProfileCredential,
  ) => {
    const runId = "boundary-run-" + ++runNumber;
    await patchSessionEntryCore(target, (entry) => ({ ...entry, activeWriterRunId: runId }));
    return await withRun(
      runId,
      async (params) => {
        const writer = await prepareCliHistoryBoundary(params, {
          credential:
            credential ??
            (epoch ? { type: "token", provider: "test-cli", token: epoch } : undefined),
        });
        return await runWithCliHistoryWriter(writer, () => action(Boolean(writer), params));
      },
      overrides,
    );
  };
  const seed = async () =>
    await run("epoch-a", async (allowed) => {
      expect(allowed).toBe(true);
      manager().appendMessage({ role: "user", content: "A private canary", timestamp: 1 });
    });
  return { target, manager, run, seed, withRun };
}

async function history(allowed: boolean, params: PreparedCliRunContext["params"]) {
  return buildCliSessionHistoryPrompt({
    messages: (
      await loadCliSessionPromptContext({
        ...params,
        allowRawTranscriptReseed: true,
        rawTranscriptReseedReason: allowed ? "missing-transcript" : "auth-unknown",
      })
    ).reseedMessages,
    prompt: "current ask",
    maxHistoryChars: 8192,
  });
}

async function settleNativeBinding(
  params: PreparedCliRunContext["params"],
  assertSettlementCurrent: () => void,
) {
  return await persistCliSessionBindingResult({
    agentId: "main",
    provider: params.provider,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    expectedSession: params.sessionEntry,
    assertSettlementCurrent,
    result: {
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "native-recovered",
          provider: params.provider,
          model: "test-model",
          cliSessionBinding: {
            sessionId: "native-recovered",
            authProfileId: "test-cli:saved",
          },
        },
      },
    },
  });
}

describe("CLI transcript account boundary", () => {
  it("prepares and commits CLI history without caller-thread data SQL", async () => {
    const f = await fixture();
    await f.seed();
    await f.withRun("worker-preparation", async (params) => {
      const sql = observeHostDataSql();
      try {
        const writer = await prepareCliHistoryBoundary(params, {
          credential: { type: "token", provider: "test-cli", token: "epoch-a" },
        });
        expect(writer).toBeDefined();
        expect(sql.queries, `MAIN SQL observations: ${sql.queries.length}`).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  });

  it("rechecks exact current-input identity inside the writer transaction", async () => {
    const f = await fixture();
    await f.seed();
    const anchor = readActiveTranscriptEntryAnchor({
      ...f.target,
      entryId: f.manager().getLeafId()!,
    });
    if (!anchor) {
      throw new Error("Missing current input anchor");
    }
    const patch = patchSessionEntryCore;
    let changed = false;
    vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementationOnce(
      (target, update, options) =>
        patch(
          target,
          async (...args) => {
            const planned = await update(...args);
            const foreign = new DatabaseSync(f.target.storePath);
            try {
              // A foreign identity edit leaves the session row and transcript watermark unchanged.
              expect(
                foreign
                  .prepare(
                    "UPDATE transcript_event_identities SET parent_id = ? WHERE session_id = ? AND event_id = ?",
                  )
                  .run("foreign-parent", f.target.sessionId, anchor.entryId).changes,
              ).toBe(1);
              changed = true;
            } finally {
              foreign.close();
            }
            return planned;
          },
          options,
        ),
    );
    await f.withRun("current-input-check", async (params) => {
      await expect(
        runWithSessionTranscriptReadFence(
          { ...anchor, role: "user", logicalTurnId: "current-input-check" },
          () =>
            prepareCliHistoryBoundary(params, {
              credential: { type: "token", provider: "test-cli", token: "epoch-a" },
            }),
        ),
      ).rejects.toThrow("Current-turn transcript admission identity changed");
      expect(changed).toBe(true);
      expect(loadSessionEntryReadOnly(f.target)?.activeWriterRunId).not.toBe(params.runId);
    });
  });

  it.each(["append", "rewrite", "reset", "revocation"] as const)(
    "refuses an intervening %s before committing the planned history boundary",
    async (change) => {
      const f = await fixture();
      await f.seed();
      const abort = new AbortController();
      const patch = patchSessionEntryCore;
      const spy = vi
        .spyOn(sessionAccessor, "patchSessionEntryCore")
        .mockImplementation((target, update, options) =>
          patch(
            target,
            async (...args) => {
              const planned = await update(...args);
              if (change === "revocation") {
                abort.abort();
              } else {
                const manager = f.manager();
                if (change === "append") {
                  manager.appendMessage({ role: "user", content: "intervening", timestamp: 2 });
                } else if (change === "rewrite") {
                  manager.appendMessage({ role: "user", content: "intervening", timestamp: 2 });
                  manager.removeTrailingEntries((entry) => entry.type === "message");
                } else {
                  manager.appendResetBoundary("reset");
                }
              }
              return planned;
            },
            options,
          ),
        );
      await f.withRun(
        "changed-preparation",
        async (params) => {
          await expect(
            prepareCliHistoryBoundary(params, {
              credential: { type: "token", provider: "test-cli", token: "epoch-a" },
            }),
          ).rejects.toThrow();
          if (change === "append" || change === "rewrite") {
            expect(spy).toHaveBeenCalledTimes(2);
          } else if (change === "revocation") {
            expect(spy).toHaveBeenCalledOnce();
          }
          expect(loadSessionEntryReadOnly(f.target)?.activeWriterRunId).not.toBe(params.runId);
        },
        { abortSignal: abort.signal },
      );
    },
  );

  it.each(["append", "rewrite"] as const)(
    "plans again after one late %s instead of failing the turn",
    async (change) => {
      const f = await fixture();
      await f.seed();
      const patch = patchSessionEntryCore;
      const spy = vi
        .spyOn(sessionAccessor, "patchSessionEntryCore")
        .mockImplementationOnce((target, update, options) =>
          patch(
            target,
            async (...args) => {
              const planned = await update(...args);
              // A finished run settles its own rows after the lane moved on.
              const manager = f.manager();
              if (change === "append") {
                manager.appendMessage({ role: "user", content: "late settle", timestamp: 2 });
              } else {
                manager.removeTrailingEntries((entry) => entry.type === "message");
              }
              return planned;
            },
            options,
          ),
        );
      await f.withRun("replanned-preparation", async (params) => {
        const writer = await prepareCliHistoryBoundary(params, {
          credential: { type: "token", provider: "test-cli", token: "epoch-a" },
        });
        expect(spy).toHaveBeenCalledTimes(2);
        expect(loadSessionEntryReadOnly(f.target)?.activeWriterRunId).toBe(params.runId);
        // The fresh plan judges the settled transcript: an unproven foreign row stays
        // unknown, while an emptied context may start a new boundary.
        expect(Boolean(writer)).toBe(change === "rewrite");
      });
    },
  );

  it("establishes coverage before the first transcript header and user row exist", async () => {
    const f = await fixture(false);
    await f.seed();
    await f.run("epoch-a", async (allowed, params) => {
      expect(await history(allowed, params)).toContain("A private canary");
    });
  });
  it("retains same-account raw and compacted history without exposing private metadata", async () => {
    const f = await fixture();
    await f.seed();
    await f.run("epoch-a", async (allowed, params) => {
      expect(await history(allowed, params)).toContain("A private canary");
      const manager = f.manager();
      const leaf = manager.getLeafId();
      if (!leaf) {
        throw new Error("Missing seeded transcript leaf");
      }
      manager.appendCompaction("A private summary", leaf, 1000);
    });
    await f.run("epoch-a", async (allowed, params) => {
      expect(await history(allowed, params)).toContain("A private summary");
    });
    const entry: InternalSessionEntry | undefined = loadSessionEntryReadOnly(f.target);
    expect(entry?.cliHistoryBoundary?.state).toBe("known");
    if (!entry) {
      throw new Error("Missing session");
    }
    expect(projectPublicSessionEntry(entry)).not.toHaveProperty("cliHistoryBoundary");
  });

  it("distinguishes OAuth account identity from rotating or identity-less tokens", async () => {
    const f = await fixture();
    const credential = {
      type: "oauth" as const,
      provider: "test-cli",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: Date.now() + 60_000,
    };
    await f.run(undefined, async (allowed) => expect(allowed).toBe(false), {}, credential);
    await f.run(
      undefined,
      async (allowed) => {
        expect(allowed).toBe(true);
        f.manager().appendMessage({ role: "user", content: "named account", timestamp: 1 });
      },
      {},
      { ...credential, accountId: "account-a" },
    );
    await f.run(
      undefined,
      async (allowed, params) => {
        expect(await history(allowed, params)).toContain("named account");
      },
      {},
      { ...credential, accountId: "account-a", access: "rotated-access" },
    );
    await f.run(
      undefined,
      async (allowed) => expect(allowed).toBe(false),
      {},
      { ...credential, accountId: "account-b" },
    );
  });

  it("compares resolved static tokens rather than the unchanged SecretRef", async () => {
    const f = await fixture();
    const tokenRef = { source: "env" as const, provider: "default", id: "TEST_TOKEN" };
    await f.run(
      undefined,
      async (allowed) => {
        expect(allowed).toBe(true);
        f.manager().appendMessage({ role: "user", content: "prior token", timestamp: 1 });
      },
      {},
      { type: "token", provider: "test-cli", token: "resolved-a", tokenRef },
    );
    await f.run(
      undefined,
      async (allowed) => expect(allowed).toBe(false),
      {},
      { type: "token", provider: "test-cli", token: "resolved-b", tokenRef },
    );
  });

  it("revokes retained read and coverage capabilities when their admitted run closes", async () => {
    const f = await fixture();
    const writer = await f.run("epoch-a", async () => getCliHistoryWriter(f.target));
    if (!writer) {
      throw new Error("Missing admitted history writer");
    }
    const before = f.manager().getEntries();
    await expect(writer.assertReadable()).rejects.toThrow();
    expect(() =>
      runWithCliHistoryWriter(writer, () =>
        f.manager().appendMessage({
          role: "user",
          content: "late write",
          timestamp: 1,
        }),
      ),
    ).toThrow();
    expect(f.manager().getEntries()).toEqual(before);
  });

  it("detaches background persistence without lending it the closed CLI history proof", async () => {
    const f = await fixture();
    const release = createDeferred();
    const { background } = await f.run("epoch-a", async () => ({
      background: runWithoutOwnedSessionTranscriptWrites(async () => {
        await release.promise;
        f.manager().appendMessage({ role: "user", content: "detached result", timestamp: 1 });
      }),
    }));
    release.resolve();
    await expect(background).resolves.toBeUndefined();
    expect(JSON.stringify(f.manager().getEntries())).toContain("detached result");
    await f.run("epoch-a", async (allowed) => expect(allowed).toBe(false));
  });

  it("cannot launder mixed history by returning to the original account", async () => {
    const f = await fixture();
    await f.seed();
    await f.run("epoch-b", async (allowed, params) => {
      expect(await history(allowed, params)).toBeUndefined();
      f.manager().appendMessage({ role: "user", content: "B private canary", timestamp: 2 });
    });
    for (const epoch of ["epoch-a", "epoch-b"]) {
      await f.run(epoch, async (allowed, params) => {
        expect(await history(allowed, params)).toBeUndefined();
      });
    }
  });

  it.each(["unrecorded append", "rewrite", "missing provenance", "old version"])(
    "refuses legacy, import, and downgrade gaps: %s",
    async (change) => {
      const f = await fixture();
      await f.seed();
      if (change === "unrecorded append") {
        // Models run by an older binary cannot advance the new coverage proof.
        f.manager().appendMessage({ role: "user", content: "unverified account", timestamp: 2 });
      } else if (change === "rewrite") {
        const manager = f.manager();
        manager.appendResetBoundary("reset", manager.getLeafId() ?? undefined);
      } else if (change === "missing provenance") {
        await patchSessionEntryCore(f.target, (entry) => ({
          ...entry,
          cliHistoryBoundary: undefined,
        }));
      } else {
        // A predecessor wrote serialized metadata outside the current typed writer contract.
        const database = new DatabaseSync(f.target.storePath);
        try {
          expect(
            database
              .prepare(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.cliHistoryBoundary.version', 0) WHERE session_key = ?",
              )
              .run(f.target.sessionKey).changes,
          ).toBe(1);
        } finally {
          database.close();
        }
      }
      await f.run("epoch-a", async (allowed, params) => {
        expect(await history(allowed, params)).toBeUndefined();
      });
    },
  );

  it("never treats an authless runtime or borrowed native session as a new trusted history", async () => {
    const f = await fixture();
    await f.run(undefined, async (allowed) => expect(allowed).toBe(false));
    await f.run("epoch-a", async (allowed) => expect(allowed).toBe(false), {
      cliSessionBinding: { sessionId: "external", forceReuse: true },
    });
  });

  it("only an empty reset can establish a fresh account boundary", async () => {
    const f = await fixture();
    await f.seed();
    await f.run("epoch-b", async (allowed) => expect(allowed).toBe(false));
    f.manager().appendResetBoundary("reset");
    await f.run("epoch-b", async (allowed) => {
      expect(allowed).toBe(true);
      f.manager().appendMessage({ role: "user", content: "B fresh canary", timestamp: 2 });
    });
    await f.run("epoch-b", async (allowed, params) => {
      const prompt = await history(allowed, params);
      expect(prompt).toContain("B fresh canary");
      expect(prompt).not.toContain("A private canary");
    });
  });

  it("admits a finished writer's successor while refusing the live writer", async () => {
    const f = await fixture();
    await f.seed();
    const identity = {
      credential: { type: "token" as const, provider: "test-cli", token: "epoch-a" },
    };
    await f.withRun("orchestrator-prior", async (params) => {
      await claimAgentSessionWriter(params);
      await f.withRun("direct-cli-blocked", async (direct) => {
        direct.sessionEntry = loadSessionEntryReadOnly(f.target);
        const before = structuredClone(direct.sessionEntry);
        await expect(prepareCliHistoryBoundary(direct, identity)).rejects.toThrow(
          "CLI history owner changed before preparation",
        );
        expect(direct.sessionEntry).toEqual(before);
      });
    });
    await f.withRun("direct-cli-recovery", async (params) => {
      params.sessionEntry = loadSessionEntryReadOnly(f.target);
      const expectedSession = params.sessionEntry;
      const writer = await prepareCliHistoryBoundary(params, identity);
      expect(writer).toBeDefined();
      if (!writer) {
        throw new Error("Missing admitted history writer");
      }
      expect(params.sessionEntry).toBe(expectedSession);
      expect(loadSessionEntryReadOnly(f.target)?.activeWriterRunId).toBe(params.runId);
      await runWithCliHistoryWriter(writer, async () => {
        expect(getOwnedSessionTranscriptWriterFence({ sessionTarget: f.target })).toEqual({
          expectedLifecycleRevision: undefined,
          expectedWriterRunId: params.runId,
        });
        expect(
          getOwnedSessionTranscriptWriterFence({
            sessionTarget: { sessionKey: f.target.sessionKey },
          }),
        ).toBeUndefined();
        expect(
          getOwnedSessionTranscriptWriterFence({
            sessionTarget: { ...f.target, storePath: path.join(f.target.storePath, "other") },
          }),
        ).toBeUndefined();
        expect(await history(true, params)).toContain("A private canary");
        const result = await persistCliAssistantTranscript({
          runParams: { ...params, persistAssistantTranscript: true },
          text: "recovered CLI answer",
          modelId: "test-model",
          stopReason: "stop",
        });
        expect(result.terminalAnchor).toBeDefined();
      });
      const settled = await settleNativeBinding(params, writer.assertCurrent);
      expect(settled.meta.error).toBeUndefined();
      expect(loadSessionEntryReadOnly(f.target)?.cliSessionBindings?.["test-cli"]).toEqual({
        sessionId: "native-recovered",
        authProfileId: "test-cli:saved",
      });
    });
    expect(JSON.stringify(f.manager().getEntries())).toContain("recovered CLI answer");
  });

  it("rechecks a revived foreign writer after metadata planning yields", async () => {
    const f = await fixture();
    await f.seed();
    await f.withRun("orchestrator-prior", async (params) => {
      await claimAgentSessionWriter(params);
    });
    const before = loadSessionEntryReadOnly(f.target);
    const replacement = prepareSystemAgentRunAdmission(
      {},
      "orchestrator-prior",
      "main",
      "history-test",
    );
    const patch = patchSessionEntryCore;
    vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementation(
      (target, update, options) =>
        patch(
          target,
          async (...args) => {
            const prepared = await update(...args);
            await replacement.admit("embedded");
            return prepared;
          },
          options,
        ),
    );
    try {
      await f.withRun("direct-cli-recovery", async (params) => {
        await expect(
          prepareCliHistoryBoundary(params, {
            credential: { type: "token", provider: "test-cli", token: "epoch-a" },
          }),
        ).rejects.toThrow("CLI history owner changed before preparation");
      });
      expect(loadSessionEntryReadOnly(f.target)).toEqual(before);
    } finally {
      replacement.close();
    }
  });

  it.each(["orchestrator-prior", "orchestrator-replacement", "direct-cli-recovery"])(
    "fences recovered history and CLI persistence after %s takes over",
    async (replacementRunId) => {
      const f = await fixture();
      await f.seed();
      await f.withRun("orchestrator-prior", async (params) => {
        await claimAgentSessionWriter(params);
      });
      await f.withRun("direct-cli-recovery", async (params) => {
        params.sessionEntry = loadSessionEntryReadOnly(f.target);
        const writer = await prepareCliHistoryBoundary(params, {
          credential: { type: "token", provider: "test-cli", token: "epoch-a" },
        });
        expect(writer).toBeDefined();
        if (!writer) {
          throw new Error("Missing admitted history writer");
        }
        await writer.assertReadable();
        await f.withRun(replacementRunId, async (replacement) => {
          await claimAgentSessionWriter(replacement);
          await expect
            .soft(writer.assertReadable())
            .rejects.toThrow(
              replacementRunId === params.runId
                ? "admitted run authority is no longer active"
                : "CLI history authority changed",
            );
          const before = f.manager().getEntries();
          await runWithCliHistoryWriter(writer, async () => {
            const result = await persistCliAssistantTranscript({
              runParams: { ...params, persistAssistantTranscript: true },
              text: "late recovered CLI answer",
              modelId: "test-model",
              stopReason: "stop",
            });
            expect.soft(result.terminalAnchor).toBeUndefined();
          });
          expect(f.manager().getEntries()).toEqual(before);
          const beforeBindingSettlement = loadSessionEntryReadOnly(f.target);
          await settleNativeBinding(params, writer.assertCurrent);
          expect(loadSessionEntryReadOnly(f.target)).toEqual(beforeBindingSettlement);
        });
      });
    },
  );
});
