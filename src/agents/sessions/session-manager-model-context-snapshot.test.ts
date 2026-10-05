import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WorkerTaskPoolCore } from "@openclaw/worker-runtime";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as contextWorker from "../../config/sessions/session-transcript-read-worker-runtime.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { readGlobalSingleton } from "../../shared/global-singleton.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { sessionManagerReadInitialContext } from "./session-manager-current-turn.js";
import { SessionManager } from "./session-manager.js";

it("refuses full context after a rewrite between validation and acceptance", async () => {
  await withOpenClawTestState({ label: "full-context-validation-reply" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "full-context-rewrite",
      sessionKey: "agent:main:full-context-rewrite",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(target);
    await source.appendMessageAsync(makeUserMessage("original", 1));
    const validated = createDeferred();
    const release = createDeferred();
    // oxlint-disable-next-line typescript/unbound-method -- Forward the original pool receiver.
    const run = WorkerTaskPoolCore.prototype.run;
    const spy = vi.spyOn(WorkerTaskPoolCore.prototype, "run").mockImplementation(async function (
      this: WorkerTaskPoolCore<unknown, unknown>,
      input,
      options,
    ) {
      const reply = await run.call(this, input, options);
      if (
        isRecord(reply) &&
        reply.ok === true &&
        isRecord(reply.value) &&
        // Include the former reply so the regression exercises the pre-fix acceptance race.
        ((isRecord(reply.value.facts) && reply.value.facts.contextValidated === true) ||
          reply.value.kind === "context-messages-current")
      ) {
        validated.resolve();
        await release.promise;
      }
      return reply;
    });
    const pending = SessionManager.readSessionContextAsync(target, (messages) => [...messages]);
    try {
      await awaitGateBeforeSettlement(
        validated.promise,
        pending,
        "Context validation was not reached",
      );
      expect(source.removeTrailingEntries((entry) => entry.type === "message")).toBe(1);
      release.resolve();
      await expect(pending).rejects.toThrow(/transcript|context/i);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      spy.mockRestore();
    }
  });
});

it("retains the full-context read owner until an awaited consumer settles", async () => {
  await withOpenClawTestState({ label: "full-context-owner-close" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "full-context-close",
      sessionKey: "agent:main:full-context-close",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(target);
    await source.appendMessageAsync(makeUserMessage("original", 1));
    const consuming = createDeferred();
    const release = createDeferred();
    let retained: Iterable<unknown> | undefined;
    const pending = SessionManager.readSessionContextAsync(target, async (messages) => {
      retained = messages;
      consuming.resolve();
      await release.promise;
      return [...messages];
    });
    let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
    try {
      await awaitGateBeforeSettlement(
        consuming.promise,
        pending,
        "Context consumer was not reached",
      );
      closing = closeOpenClawAgentDatabaseByPathAsync(target.storePath);
      release.resolve();
      await expect(pending).rejects.toThrow(/revoked|closed|current|admission/i);
      expect([...retained!]).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([pending, closing]);
    }
  });
});

it.each(["key", "path"] as const)(
  "rejects a replaced native owner selected by %s",
  async (route) => {
    await withOpenClawTestState({ label: "native-context-owner" }, async (state) => {
      const pathname = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      const options = { agentId: "main", path: pathname, env: state.env };
      const original = openOpenClawAgentDatabase(options);
      const target = {
        agentId: "main",
        sessionId: "empty-native-context",
        sessionKey:
          route === "key"
            ? "agent:main:dashboard:incognito-context-owner"
            : "agent:main:context-owner",
        storePath:
          route === "key" ? path.join(state.agentDir("main"), "openclaw-agent.sqlite") : pathname,
        env: state.env,
      };
      await expect(
        SessionManager.readSessionContextAsync(target, async (messages) => {
          expect([...messages]).toEqual([]);
          await closeOpenClawAgentDatabaseByPathAsync(pathname, "main");
          expect(openOpenClawAgentDatabase(options)).not.toBe(original);
          return "stale owner result";
        }),
      ).rejects.toThrow("incognito database owner is no longer current");
      expect(
        await SessionManager.readSessionContextAsync(target, (messages) => [...messages]),
      ).toEqual([]);
      expect(fs.existsSync(pathname)).toBe(false);
    });
  },
);

it("reads full durable context through workers and preserves the deprecated synchronous result", async () => {
  await withOpenClawTestState({ label: "context-read-async" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "full-context",
      sessionKey: "agent:main:full-context",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target);
    const seeded = await manager.appendMessageWithTranscriptAnchorAsync(
      Object.assign(makeUserMessage("full fidelity", 1), {
        __openclaw: { upstreamUserText: "synthetic-private-native-text" },
      }),
    );
    if (!seeded.anchor) {
      throw new Error("Missing initial transcript anchor");
    }
    const warned = readGlobalSingleton(Symbol.for("openclaw.sessionPersistenceDeprecations"));
    if (!(warned instanceof Set)) {
      throw new Error("Missing session persistence warning budget");
    }
    const warningKey = "SessionManager.readSessionContext";
    const previouslyWarned = warned.delete(warningKey);
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    let expected: unknown;
    try {
      expected = SessionManager.readSessionContext(target, (messages) => [...messages]);
      expect(SessionManager.readSessionContext(target, () => 7)).toBe(7);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("readSessionContextAsync"),
        { code: "DEP_SESSION_PERSISTENCE", type: "DeprecationWarning" },
      );
    } finally {
      warn.mockRestore();
      if (previouslyWarned) {
        warned.add(warningKey);
      } else {
        warned.delete(warningKey);
      }
    }
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      expect(
        await SessionManager.readSessionContextAsync(target, async (messages, header) => {
          expect(header).toMatchObject({ id: target.sessionId });
          await Promise.resolve();
          return [...messages];
        }),
      ).toEqual(expected);
      expect(prepare).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      exec.mockRestore();
    }
    await expect(
      SessionManager.readSessionContextAsync(target, async () => {
        await manager.appendMessageAsync(makeUserMessage("changed", 2));
      }),
    ).rejects.toThrow("changed during context read");
    const missing = { ...target, storePath: path.join(state.agentDir("main"), "absent.sqlite") };
    await expect(
      SessionManager.readSessionContextAsync(missing, () => "unreadable", {
        admission: {
          ...seeded.anchor,
          storePath: missing.storePath,
          role: "user",
          logicalTurnId: "missing-source",
        },
      }),
    ).rejects.toThrow("Session transcript changed during context read");
    expect(fs.existsSync(missing.storePath)).toBe(false);
    const alias = path.join(state.stateDir, "context-alias");
    const successor = path.join(state.stateDir, "missing-successor");
    fs.mkdirSync(successor);
    fs.symlinkSync(path.dirname(target.storePath), alias, "junction");
    await expect(
      SessionManager.readSessionContextAsync(
        { ...target, storePath: path.join(alias, path.basename(target.storePath)) },
        async () => {
          fs.unlinkSync(alias);
          fs.symlinkSync(successor, alias, "junction");
        },
      ),
    ).rejects.toThrow(/captured|identity|owner/);
  });
});

it.each([false, true])("shares immutable initial messages (incognito=%s)", async (incognito) => {
  await withOpenClawTestState({ label: "shared-model-context" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "shared-context",
      sessionKey: incognito
        ? "agent:main:dashboard:incognito-shared-context"
        : "agent:main:shared-context",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const seed = await SessionManager.openAsync(scope);
    const userId = await seed.appendMessageAsync({
      role: "user",
      content: "question",
      timestamp: 1,
    });
    const replyId = await seed.appendMessageAsync(
      Object.assign(makeAgentAssistantMessage({ content: [{ type: "text", text: "answer" }] }), {
        __openclaw: { upstreamUserText: "synthetic-private-native-payload" },
      }),
    );
    const manager = await SessionManager.openAsync(scope, undefined, {
      maxEvents: 20,
      maxBytes: 8192,
    });
    const context = await manager[sessionManagerReadInitialContext]();
    const user = manager.getEntry(userId!);
    const reply = manager.getEntry(replyId!);
    const projectedReply = context.messages[1];
    if (
      user?.type !== "message" ||
      reply?.type !== "message" ||
      reply.message.role !== "assistant" ||
      projectedReply?.role !== "assistant"
    ) {
      throw new Error("Missing stored messages");
    }
    expect(context.messages[0]).toBe(user.message);
    expect(projectedReply.content).toBe(reply.message.content);
    expect(Object.isFrozen(user.message)).toBe(true);
    expect(Object.isFrozen(reply.message.content)).toBe(true);
    expect(JSON.stringify(context)).not.toContain("synthetic-private-native-payload");
    expect(Reflect.set(projectedReply.content[0]!, "text", "changed")).toBe(false);
    expect(reply.message.content).toEqual([{ type: "text", text: "answer" }]);
  });
});

it.each(
  [false, true].flatMap((incognito) =>
    (["append", "rewrite"] as const).map((mutation) => ({ incognito, mutation })),
  ),
)(
  "reads the completed-turn snapshot across later $mutation (incognito=$incognito)",
  async ({ incognito, mutation }) => {
    await withOpenClawTestState({ label: "completed-model-context" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "completed-context",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-completed-context"
          : "agent:main:completed-context",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = SessionManager.open(scope);
      source.appendMessage({ role: "user", content: "completed question", timestamp: 1 });
      await waitForSessionTranscriptProjection(scope);
      const terminal = source.appendMessageWithTranscriptAnchor(
        Object.assign(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "completed answer" }],
          }),
          { __openclaw: { upstreamUserText: "synthetic-private-native-payload" } },
        ),
      );
      if (!terminal.anchor) {
        throw new Error("Missing completed-turn anchor");
      }
      const expected = SessionManager.openModelContext(scope).buildSessionContext();
      source.appendMessage({ role: "user", content: "later question", timestamp: 2 });
      const mutate = () => {
        if (mutation === "rewrite") {
          source.removeTrailingEntries((entry) => entry.type === "message");
        }
        source.appendMessage({ role: "user", content: "newest question", timestamp: 3 });
      };
      const spy = incognito
        ? undefined
        : vi
            .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
            .mockImplementationOnce(async (...args) => {
              spy!.mockRestore();
              const result = await contextWorker.readSessionTranscriptModelContextInWorker(...args);
              mutate();
              return result;
            });
      try {
        const pending = SessionManager.openModelContextAsync(scope, { through: terminal.anchor });
        if (incognito) {
          mutate();
        }
        if (mutation === "rewrite") {
          await expect(pending).rejects.toThrow(/transcript|anchor/i);
        } else {
          const context = (await pending).buildSessionContext();
          expect(context).toEqual(expected);
          expect(JSON.stringify(context)).not.toContain("synthetic-private-native-payload");
          expect(source.buildSessionContext().messages.at(-1)).toMatchObject({
            content: "newest question",
          });
        }
      } finally {
        spy?.mockRestore();
      }
    });
  },
);
