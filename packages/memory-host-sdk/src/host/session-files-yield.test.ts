// Memory Host SDK tests cover session files yield behavior.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../../../../src/config/sessions/session-accessor.js";
import { replaceTranscriptEventsSync } from "../../../../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { useSessionStoreTempDirs } from "../../../../src/test-utils/session-state-cleanup.js";
import { buildSessionEntry, streamSessionEntry } from "./session-files.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "session-entry-yield-");

describe("buildSessionEntry responsiveness", () => {
  // SQLite exports render in the transcript worker and observe messages one page at a time.
  it.each(["archive", "sqlite"])(
    "yields at raw ordinals even for excluded %s records",
    async (source) => {
      const root = sessionDirs.make();
      const scope = {
        agentId: "main",
        sessionId: "yield",
        sessionKey: "agent:main:yield",
        storePath: path.join(root, "sessions.json"),
      };
      const records = Array.from({ length: 25 }, (_value, index) =>
        index % 2 === 1
          ? null
          : {
              type: "message",
              id: `message-${index}`,
              message: {
                role: index === 0 || index === 24 ? "user" : "assistant",
                content: `message ${index}`,
                ...(index === 0
                  ? { provenance: { kind: "internal_system", sourceTool: "heartbeat" } }
                  : {}),
              },
            },
      );
      const archivePath = path.join(root, "yield.jsonl.deleted.2026-07-01T10-00-00.000Z");
      if (source === "sqlite") {
        await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        expect(replaceTranscriptEventsSync(scope, records)).toBe(true);
      } else {
        fs.writeFileSync(
          archivePath,
          records
            .map((record, index) =>
              record ? JSON.stringify(record) : index % 4 === 1 ? "" : "malformed",
            )
            .join("\n"),
        );
      }
      let observed = 0;
      let observedAtYield: number | undefined;
      let immediate: Promise<void> | undefined;
      const entry = await buildSessionEntry(source === "sqlite" ? scope.sessionKey : archivePath, {
        ...(source === "sqlite" ? scope : {}),
        generatedByCronRun: false,
        generatedByDreamingNarrative: false,
        parseYieldEveryLines: 10,
        onTranscriptMessage: () => {
          observed++;
          immediate ??= new Promise<void>((resolve) => {
            setImmediate(() => {
              observedAtYield = observed;
              resolve();
            });
          });
        },
      });

      await immediate;
      expect(observedAtYield).toBe(source === "sqlite" ? 13 : 5);
      expect(observed).toBe(13);
      expect(entry?.content).toBe("User: message 24");
      expect(entry?.lineMap).toEqual([25]);
    },
  );

  it.each(["rewrite", "classification"])(
    "settles legacy observers only once after a streamed %s",
    async (change) => {
      const root = sessionDirs.make();
      const scope = {
        agentId: "main",
        sessionId: "observer-settlement",
        sessionKey: "agent:main:observer-settlement",
        storePath: path.join(root, "sessions.json"),
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      // Exceed the snapshot and slice budgets so the change occurs between real worker reads.
      const records = Array.from({ length: 6 }, (_, index) => ({
        type: "message",
        id: "row-" + index,
        message: { role: "user", content: ("row" + index + " ").repeat(200_000) },
      }));
      expect(
        replaceTranscriptEventsSync(scope, [
          ...records,
          ...(change === "classification"
            ? [
                {
                  type: "custom",
                  customType: "openclaw:bootstrap-context:full",
                  data: { runId: "dreaming-narrative-observer-settlement" },
                },
              ]
            : []),
        ]),
      ).toBe(true);
      const observed: unknown[] = [];
      let changed = false;
      const summary = await streamSessionEntry(
        scope.sessionKey,
        { ...scope, onTranscriptMessage: (message) => observed.push(message) },
        {
          onPage() {
            expect(observed).toEqual([]);
            if (change === "rewrite" && !changed) {
              changed = true;
              expect(
                replaceTranscriptEventsSync(scope, [
                  {
                    type: "message",
                    id: "replacement",
                    message: { role: "user", content: "replacement" },
                  },
                ]),
              ).toBe(true);
            }
          },
          // No onReset: the shipped observer contract cannot retract callback effects.
        },
      );
      expect(summary).not.toBeNull();
      expect(observed).toEqual(
        change === "rewrite"
          ? [{ role: "user", content: "replacement" }]
          : records.map((record) => record.message),
      );
      if (change === "classification") {
        expect(summary?.generatedByDreamingNarrative).toBe(true);
        expect(summary?.lineCount).toBe(0);
      }
    },
  );
});
