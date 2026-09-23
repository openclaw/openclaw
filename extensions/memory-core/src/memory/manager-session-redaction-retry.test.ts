import { DatabaseSync } from "node:sqlite";
import { WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { generateSecureToken } from "openclaw/plugin-sdk/secure-random-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createManagerIndexFixture,
  readPublishedSessionIndex,
} from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory session redaction retry", () => {
  const { createConfig, getFreshManager, seedSessionTranscript } = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each(["full", "targeted"] as const)(
    "preserves the published index after repeated redaction changes during %s sync",
    async (mode) => {
      const sessionId = `redaction-retry-${mode}`;
      const sessionKey = `agent:main:chat:${sessionId}`;
      const sessionPath = `sessions/main/${sessionId}.jsonl`;
      await seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [{ role: "user", timestamp: 1, content: "Published violet preference." }],
      });
      const manager = await getFreshManager(
        createConfig({
          provider: "none",
          sources: ["sessions"],
          sessionMemory: true,
          vectorEnabled: false,
        }),
        "cli",
      );
      await manager.sync({ reason: "before-redaction-change", force: true });
      const observer = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), {
        readOnly: true,
      });
      try {
        const before = readPublishedSessionIndex(observer, sessionPath, "violet");
        expect(before.source).toBeDefined();
        expect(before.chunks).toHaveLength(1);
        expect(before.search).toHaveLength(1);
        await seedSessionTranscript({
          sessionId,
          sessionKey,
          messages: [
            { role: "assistant", timestamp: 2, content: "New violet response after publication." },
          ],
        });

        // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the intercepted pool receiver.
        const run = WorkerTaskPool.prototype.run;
        let invalidations = 0;
        const replies = vi
          .spyOn(WorkerTaskPool.prototype, "run")
          .mockImplementation(async function (this: WorkerTaskPool<unknown, unknown>, ...args) {
            const result = await Reflect.apply(run, this, args);
            const input = asOptionalRecord(args[0]);
            if (
              input?.kind === "session-entry" &&
              asOptionalRecord(input.options)?.sessionId === sessionId &&
              invalidations < 2
            ) {
              invalidations += 1;
              generateSecureToken({ redact: true });
            }
            return result;
          });
        try {
          await expect(
            manager.sync({
              reason: "repeated-redaction-change",
              ...(mode === "full" ? { force: true } : { sessions: [{ sessionId, sessionKey }] }),
            }),
          ).rejects.toThrow(
            "Session transcript redaction changed during preparation; retry the operation.",
          );
          expect(invalidations).toBe(2);
          expect(readPublishedSessionIndex(observer, sessionPath, "violet")).toEqual(before);
          expect(manager.status().dirty).toBe(true);
          expect(manager.status().lastSyncError).toContain(
            "Session transcript redaction changed during preparation",
          );
        } finally {
          replies.mockRestore();
        }

        await manager.sync({ reason: "retry-after-redaction-change" });
        const recovered = readPublishedSessionIndex(observer, sessionPath, "violet");
        expect(recovered.source?.hash).not.toBe(before.source?.hash);
        expect(recovered.chunks.map((chunk) => chunk.text).join("\n")).toContain(
          "New violet response after publication.",
        );
        expect(recovered.search.map((chunk) => chunk.text).join("\n")).toContain(
          "New violet response after publication.",
        );
        expect(manager.status().dirty).toBe(false);
        expect(manager.status().lastSyncError).toBeUndefined();
      } finally {
        observer.close();
      }
    },
  );
});
