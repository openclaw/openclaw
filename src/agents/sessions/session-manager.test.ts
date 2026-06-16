// Session manager tests cover JSONL recovery behavior for interrupted or
// corrupted transcript writes.
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { prepareSessionManagerForRun } from "../embedded-agent-runner/session-manager-init.js";
import { repairSessionFileIfNeeded } from "../session-file-repair.js";
import {
  CURRENT_SESSION_VERSION,
  loadEntriesFromFile,
  SessionManager,
  type SessionEntry,
} from "./session-manager.js";

const tempPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-manager-"));
  tempPaths.push(dir);
  return dir;
}

describe("SessionManager.open", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("recovers a corrupted first-line header without truncating later messages", async () => {
    // A damaged header should be repairable without treating valid later
    // message entries as disposable transcript state.
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const originalHeader = {
      type: "session",
      version: 3,
      id: "original-session",
      timestamp: "2026-05-27T00:00:00.000Z",
      cwd: "/srv/openclaw/main",
    };
    const userEntry = {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-05-27T00:00:01.000Z",
      message: { role: "user", content: "important question" },
    };
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-05-27T00:00:02.000Z",
      message: { role: "assistant", content: "important answer" },
    };
    const originalTranscript =
      [
        JSON.stringify(originalHeader).slice(0, 30),
        JSON.stringify(userEntry),
        JSON.stringify(assistantEntry),
      ].join("\n") + "\n";
    await fs.writeFile(sessionFile, originalTranscript, "utf8");
    if (process.platform !== "win32") {
      await fs.chmod(sessionFile, 0o600);
    }

    const sessionManager = SessionManager.open(sessionFile, dir, "/tmp/task-repo");

    expect(sessionManager.getEntries()).toEqual([userEntry, assistantEntry]);
    expect(await fs.readFile(sessionFile, "utf8")).toContain("important question");
    expect(await fs.readFile(sessionFile, "utf8")).toContain("important answer");
    await expect(fs.readFile(sessionFile, "utf8")).resolves.not.toBe(originalTranscript);

    const backupFiles = (await fs.readdir(dir)).filter((file) => file.includes(".corrupt-"));
    expect(backupFiles).toHaveLength(1);
    // Keep an exact backup for audit/debugging before rewriting the live file.
    await expect(fs.readFile(path.join(dir, backupFiles[0] ?? ""), "utf8")).resolves.toBe(
      originalTranscript,
    );
    if (process.platform !== "win32") {
      const backupStat = await fs.stat(path.join(dir, backupFiles[0] ?? ""));
      expect(backupStat.mode & 0o777).toBe(0o600);
    }
  });

  it("does not duplicate the header after recovering a header-only corrupt file", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(sessionFile, '{"type":"session","version":3,"id":"sess', "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, "/tmp/task-repo");
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "messages",
      provider: "anthropic",
      model: "sonnet-4.6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const entries = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });

    expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "message"]);
    expect(entries.filter((entry) => entry.type === "session")).toHaveLength(1);
  });

  it("still migrates old transcript versions while bypassing the warm cache", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const legacyHeader = {
      type: "session",
      version: 2,
      id: "legacy-session",
      timestamp: "2026-06-04T00:00:00.000Z",
      cwd: dir,
    };
    const legacyEntry = {
      type: "message",
      id: "legacy-entry",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: {
        role: "hookMessage",
        content: "legacy hook content",
      },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(legacyHeader)}\n${JSON.stringify(legacyEntry)}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);

    expect(sessionManager.getHeader()?.version).toBe(CURRENT_SESSION_VERSION);
    expect(sessionManager.getEntries()).toEqual([
      {
        ...legacyEntry,
        message: { ...legacyEntry.message, role: "custom" },
      },
    ]);
    const persistedEntries = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; version?: number; message?: unknown });
    expect(persistedEntries[0]).toMatchObject({
      type: "session",
      version: CURRENT_SESSION_VERSION,
    });
    expect(persistedEntries[1]).toMatchObject({
      type: "message",
      message: { role: "custom" },
    });
  });

  it("reuses current transcript entries across warm opens and appends without stale readback", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const secondMessage = buildAssistantMessage("message 2");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      expect(SessionManager.open(sessionFile, dir, dir).getEntries()).toEqual([firstEntry]);
      expect(parseCount).toBe(2);

      parseCount = 0;
      expect(SessionManager.open(sessionFile, dir, dir).getEntries()).toEqual([firstEntry]);
      expect(parseCount).toBe(0);

      const sessionManager = SessionManager.open(sessionFile, dir, dir);
      let trustedSnapshot = await readTrustedRepairSnapshot(sessionFile);
      let cacheAdvanceChecks = 0;
      let snapshotPublications = 0;
      await withOwnedSessionTranscriptWrites(
        {
          sessionFile,
          canAdvanceSessionEntryCache: (snapshot) => {
            cacheAdvanceChecks += 1;
            expect(snapshot).toEqual(trustedSnapshot);
            return true;
          },
          publishSessionFileSnapshot: (snapshot) => {
            snapshotPublications += 1;
            trustedSnapshot = snapshot;
            return true;
          },
          withSessionWriteLock: async (run) => await run(),
        },
        async () => {
          sessionManager.appendMessage(secondMessage);
          sessionManager.appendMessage(buildAssistantMessage("message 3"));
        },
      );
      expect(cacheAdvanceChecks).toBe(2);
      expect(snapshotPublications).toBe(2);
      const persistedEntries = (await fs.readFile(sessionFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => originalParse(line) as { type: string });
      expect(persistedEntries.map((entry) => entry.type)).toEqual([
        "session",
        "message",
        "message",
        "message",
      ]);

      parseCount = 0;
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getEntries().map((entry) => readMessageContent(entry))).toEqual([
        "message 1",
        "message 2",
        "message 3",
      ]);
      expect(parseCount).toBe(0);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("publishes owned snapshots when a safe append pushes the transcript over the cache limit", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "large-session.jsonl");
    const maxCachedSessionBytes = 32 * 1024 * 1024;
    const headerLine = JSON.stringify(buildSessionHeader(dir));
    const largeEntryBase = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage(""),
    };
    const initialTranscriptWithContent = (content: string) =>
      `${headerLine}\n${JSON.stringify({
        ...largeEntryBase,
        message: buildAssistantMessage(content),
      })}\n`;
    let filler = "x".repeat(
      maxCachedSessionBytes - Buffer.byteLength(initialTranscriptWithContent(""), "utf8") - 16,
    );
    while (
      Buffer.byteLength(initialTranscriptWithContent(filler), "utf8") >
      maxCachedSessionBytes - 16
    ) {
      filler = filler.slice(0, -1024);
    }
    await fs.writeFile(sessionFile, initialTranscriptWithContent(filler), "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    const publishSessionFileSnapshot = vi.fn(() => true);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendMessage(buildAssistantMessage("small append"));
      },
    );

    expect(Buffer.byteLength(await fs.readFile(sessionFile, "utf8"), "utf8")).toBeGreaterThan(
      maxCachedSessionBytes,
    );
    expect(publishSessionFileSnapshot).toHaveBeenCalledTimes(1);
  });

  it("invalidates warm entries after an append outside the owned write context", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    sessionManager.appendMessage(buildAssistantMessage("message 2"));

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      expect(
        SessionManager.open(sessionFile, dir, dir)
          .getEntries()
          .map((entry) => readMessageContent(entry)),
      ).toEqual(["message 1", "message 2"]);
      expect(parseCount).toBeGreaterThanOrEqual(3);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("caches the persisted JSON shape for owned appends", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(assistantEntry)}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendCustomEntry("json-shape", {
          date: new Date("2026-06-15T00:00:00.000Z"),
          dropped: () => "not persisted",
          nan: Number.NaN,
        });
      },
    );

    const warmEntry = SessionManager.open(sessionFile, dir, dir)
      .getEntries()
      .find((entry) => entry.type === "custom");
    const freshEntry = loadEntriesFromFile(sessionFile).find((entry) => entry.type === "custom");
    expect(warmEntry).toEqual(freshEntry);
    expect(warmEntry).toMatchObject({
      data: {
        date: "2026-06-15T00:00:00.000Z",
        nan: null,
      },
    });
    expect((warmEntry as { data?: Record<string, unknown> }).data).not.toHaveProperty("dropped");
  });

  it("serializes owned appends once and caches those exact bytes", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(assistantEntry)}\n`,
      "utf8",
    );

    let serializationCount = 0;
    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendCustomEntry("stateful-json", {
          value: {
            toJSON() {
              serializationCount += 1;
              return serializationCount === 1 ? "first" : "later";
            },
          },
        });
      },
    );

    const warmEntry = SessionManager.open(sessionFile, dir, dir)
      .getEntries()
      .find((entry) => entry.type === "custom");
    const freshEntry = loadEntriesFromFile(sessionFile).find((entry) => entry.type === "custom");
    expect(serializationCount).toBe(1);
    expect(warmEntry).toEqual(freshEntry);
    expect(warmEntry).toMatchObject({ data: { value: "first" } });
  });

  it("validates the transcript prefix after entries with custom serializers are serialized", async () => {
    const appenders: Array<{
      name: string;
      append: (manager: SessionManager, value: unknown) => void;
    }> = [
      {
        name: "custom",
        append: (manager, value) =>
          manager.appendCustomEntry("rewrite-during-serialization", {
            value,
          }),
      },
      {
        name: "custom_message",
        append: (manager, value) =>
          manager.appendCustomMessageEntry(
            "rewrite-during-serialization",
            "extension message",
            false,
            { value },
          ),
      },
      {
        name: "compaction",
        append: (manager, value) =>
          manager.appendCompaction("summary", "assistant-1", 1, { value }, true),
      },
      {
        name: "branch_summary",
        append: (manager, value) =>
          manager.branchWithSummary("assistant-1", "summary", { value }, true),
      },
      {
        name: "tool_result_details",
        append: (manager, value) =>
          manager.appendMessage({
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "test",
            content: [{ type: "text", text: "ok" }],
            details: { value },
            isError: false,
            timestamp: Date.now(),
          } as Parameters<SessionManager["appendMessage"]>[0]),
      },
    ];

    const serializerCases: Array<{
      name: string;
      createValue: (rewriteTranscript: () => void) => {
        value: unknown;
        cleanup?: () => void;
      };
    }> = [
      {
        name: "own_to_json",
        createValue: (rewriteTranscript) => ({
          value: {
            toJSON() {
              rewriteTranscript();
              return "persisted";
            },
          },
        }),
      },
      {
        name: "non_enumerable_array_index",
        createValue: (rewriteTranscript) => {
          const array = ["placeholder"];
          Object.defineProperty(array, "0", {
            configurable: true,
            enumerable: false,
            value: {
              toJSON() {
                rewriteTranscript();
                return "persisted";
              },
            },
          });
          return { value: array };
        },
      },
      {
        name: "bigint_to_json",
        createValue: (rewriteTranscript) => {
          const originalBigIntToJson = Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON");
          // eslint-disable-next-line no-extend-native -- JSON.stringify invokes BigInt.prototype.toJSON when present.
          Object.defineProperty(BigInt.prototype, "toJSON", {
            configurable: true,
            value() {
              rewriteTranscript();
              return "persisted";
            },
          });
          return {
            value: 1n,
            cleanup: () => {
              if (originalBigIntToJson) {
                // eslint-disable-next-line no-extend-native -- Restore the serializer installed for this case.
                Object.defineProperty(BigInt.prototype, "toJSON", originalBigIntToJson);
              } else {
                delete (BigInt.prototype as { toJSON?: unknown }).toJSON;
              }
            },
          };
        },
      },
    ];

    for (const { name, append } of appenders) {
      for (const serializerCase of serializerCases) {
        const dir = await makeTempDir();
        const sessionFile = path.join(dir, `${name}-${serializerCase.name}.jsonl`);
        const originalEntry = {
          type: "message",
          id: "assistant-1",
          parentId: null,
          timestamp: "2026-06-04T00:00:01.000Z",
          message: buildAssistantMessage("message 1"),
        };
        const replacementEntry = {
          ...originalEntry,
          message: buildAssistantMessage("changed 1"),
        };
        const headerLine = JSON.stringify(buildSessionHeader(dir));
        await fs.writeFile(
          sessionFile,
          `${headerLine}\n${JSON.stringify(originalEntry)}\n`,
          "utf8",
        );

        const sessionManager = SessionManager.open(sessionFile, dir, dir);
        let cacheAdvanceChecks = 0;
        const publishSessionFileSnapshot = vi.fn(() => true);
        const { value, cleanup } = serializerCase.createValue(() => {
          writeFileSync(
            sessionFile,
            `${headerLine}\n${JSON.stringify(replacementEntry)}\n`,
            "utf8",
          );
        });

        try {
          await withOwnedSessionTranscriptWrites(
            {
              sessionFile,
              canAdvanceSessionEntryCache: () => {
                cacheAdvanceChecks += 1;
                return true;
              },
              publishSessionFileSnapshot,
              withSessionWriteLock: async (run) => await run(),
            },
            async () => {
              append(sessionManager, value);
            },
          );
        } finally {
          cleanup?.();
        }

        expect(
          SessionManager.open(sessionFile, dir, dir)
            .getEntries()
            .filter((entry) => entry.type === "message")
            .map((entry) => readMessageContent(entry)),
        ).toEqual(name === "tool_result_details" ? ["changed 1", "ok"] : ["changed 1"]);
        expect(cacheAdvanceChecks, `${name}/${serializerCase.name}`).toBe(0);
        expect(publishSessionFileSnapshot, `${name}/${serializerCase.name}`).not.toHaveBeenCalled();
      }
    }
  });

  it("does not probe custom entry getters before serialization", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(assistantEntry)}\n`,
      "utf8",
    );

    let accessCount = 0;
    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendCustomEntry("getter-data", {
          get cursor() {
            accessCount += 1;
            return `value ${accessCount}`;
          },
        });
      },
    );

    const freshEntry = loadEntriesFromFile(sessionFile).find((entry) => entry.type === "custom");
    expect(accessCount).toBe(1);
    expect(freshEntry).toMatchObject({ data: { cursor: "value 1" } });
  });

  it("invalidates custom function serializers before advancing the cache", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    const replacementEntry = {
      ...assistantEntry,
      message: buildAssistantMessage("changed 1"),
    };
    const headerLine = JSON.stringify(buildSessionHeader(dir));
    await fs.writeFile(sessionFile, `${headerLine}\n${JSON.stringify(assistantEntry)}\n`, "utf8");

    const serializer = Object.assign(function serialize() {}, {
      toJSON() {
        writeFileSync(sessionFile, `${headerLine}\n${JSON.stringify(replacementEntry)}\n`, "utf8");
        return "persisted";
      },
    });

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendCustomEntry("function-serializer", { value: serializer });
      },
    );

    const reopenedPrefix = SessionManager.open(sessionFile, dir, dir)
      .getEntries()
      .find((entry) => entry.id === "assistant-1");
    expect(reopenedPrefix ? readMessageContent(reopenedPrefix) : undefined).toBe("changed 1");
  });

  it("validates custom message detail hooks before advancing the cache", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    const replacementEntry = {
      ...assistantEntry,
      message: buildAssistantMessage("changed 1"),
    };
    const headerLine = JSON.stringify(buildSessionHeader(dir));
    await fs.writeFile(sessionFile, `${headerLine}\n${JSON.stringify(assistantEntry)}\n`, "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendCustomMessageEntry("details-hook", "visible", false, {
          value: {
            toJSON() {
              writeFileSync(
                sessionFile,
                `${headerLine}\n${JSON.stringify(replacementEntry)}\n`,
                "utf8",
              );
              return "persisted";
            },
          },
        });
      },
    );

    expect(
      SessionManager.open(sessionFile, dir, dir)
        .getEntries()
        .filter((entry) => entry.type === "message")
        .map((entry) => readMessageContent(entry)),
    ).toEqual(["changed 1"]);
  });

  it("detects tool-result detail hooks before advancing the cache", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    const replacementEntry = {
      ...assistantEntry,
      message: buildAssistantMessage("changed 1"),
    };
    const headerLine = JSON.stringify(buildSessionHeader(dir));
    await fs.writeFile(sessionFile, `${headerLine}\n${JSON.stringify(assistantEntry)}\n`, "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendMessage({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "custom",
          content: [{ type: "text", text: "unused" }],
          details: {
            value: {
              toJSON() {
                writeFileSync(
                  sessionFile,
                  `${headerLine}\n${JSON.stringify(replacementEntry)}\n`,
                  "utf8",
                );
                return "persisted";
              },
            },
          },
          isError: false,
          timestamp: Date.now(),
        });
      },
    );

    const reopenedPrefix = SessionManager.open(sessionFile, dir, dir)
      .getEntries()
      .find((entry) => entry.id === "assistant-1");
    expect(reopenedPrefix ? readMessageContent(reopenedPrefix) : undefined).toBe("changed 1");
  });

  it("does not warm-cache tool-result detail appends", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(assistantEntry)}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendMessage({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "custom",
          content: [{ type: "text", text: "unused" }],
          details: { source: "extension" },
          isError: false,
          timestamp: Date.now(),
        });
      },
    );

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      expect(SessionManager.open(sessionFile, dir, dir).getEntries()).toHaveLength(2);
      expect(parseCount).toBeGreaterThan(0);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("detects assistant tool-call hook writes before advancing the cache", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    const replacementEntry = {
      ...assistantEntry,
      message: buildAssistantMessage("changed 1"),
    };
    const headerLine = JSON.stringify(buildSessionHeader(dir));
    await fs.writeFile(sessionFile, `${headerLine}\n${JSON.stringify(assistantEntry)}\n`, "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendMessage({
          ...buildAssistantMessage("unused"),
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "custom",
              arguments: {
                value: {
                  toJSON() {
                    writeFileSync(
                      sessionFile,
                      `${headerLine}\n${JSON.stringify(replacementEntry)}\n`,
                      "utf8",
                    );
                    return "persisted";
                  },
                },
              },
            },
          ],
          stopReason: "toolUse",
        });
      },
    );

    const reopenedPrefix = SessionManager.open(sessionFile, dir, dir)
      .getEntries()
      .find((entry) => entry.id === "assistant-1");
    expect(reopenedPrefix ? readMessageContent(reopenedPrefix) : undefined).toBe("changed 1");
  });

  it("invalidates incremental repair when append ownership cannot be proven", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    const headerLine = JSON.stringify(buildSessionHeader(dir));
    const assistantLine = JSON.stringify(assistantEntry);
    await fs.writeFile(sessionFile, `${headerLine}\n${assistantLine}\n`, "utf8");
    await repairSessionFileIfNeeded({
      sessionFile,
      trustedSnapshot: await readTrustedRepairSnapshot(sessionFile),
    });

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => false,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendCustomEntry("corrupt-prefix-during-serialization", {
          value: {
            toJSON() {
              writeFileSync(sessionFile, `${headerLine}\n!${assistantLine.slice(1)}\n`, "utf8");
              return "persisted";
            },
          },
        });
      },
    );

    await repairSessionFileIfNeeded({
      sessionFile,
      trustedSnapshot: await readTrustedRepairSnapshot(sessionFile),
    });
    const repairedEntries = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(repairedEntries.map((entry) => entry.type)).toEqual(["session", "custom"]);
  });

  it("separates an owned append from an unterminated transcript entry", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendMessage(buildAssistantMessage("message 2"));
      },
    );

    const content = await fs.readFile(sessionFile, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    expect(content.trimEnd().split("\n")).toHaveLength(3);
    expect(
      loadEntriesFromFile(sessionFile)
        .filter((entry) => entry.type === "message")
        .map((entry) => readMessageContent(entry)),
    ).toEqual(["message 1", "message 2"]);
  });

  it("caches the persisted JSON shape after a deferred full write", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    let serializationCount = 0;
    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    sessionManager.appendCustomEntry("json-shape", {
      kept: "value",
      dropped: () => "not persisted",
      stateful: {
        toJSON() {
          serializationCount += 1;
          return serializationCount === 1 ? "first" : "later";
        },
      },
    });

    expect(() => {
      sessionManager.appendMessage(buildAssistantMessage("first assistant"));
    }).not.toThrow();

    const warmEntry = SessionManager.open(sessionFile, dir, dir)
      .getEntries()
      .find((entry) => entry.type === "custom");
    expect(serializationCount).toBe(1);
    expect(warmEntry).toMatchObject({ data: { kept: "value", stateful: "first" } });
    expect((warmEntry as { data?: Record<string, unknown> }).data).not.toHaveProperty("dropped");
  });

  it("keeps the exported file loader mutable and separate from warm SessionManager entries", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const loaded = loadEntriesFromFile(sessionFile);
    const messageEntry = loaded[1];
    if (!messageEntry || messageEntry.type !== "message") {
      throw new Error("expected message entry");
    }
    (messageEntry.message as { content: unknown }).content = "caller-owned mutation";

    expect(readMessageContent(messageEntry)).toBe("caller-owned mutation");
    expect(
      SessionManager.open(sessionFile, dir, dir)
        .getEntries()
        .map((entry) => readMessageContent(entry)),
    ).toEqual(["message 1"]);
  });

  it("invalidates the transcript entry cache when the file is externally replaced", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const replacementEntry = buildMessageEntry(2, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    expect(SessionManager.open(sessionFile, dir, dir).getEntries()).toEqual([firstEntry]);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir, "replacement-session"))}\n${JSON.stringify(
        replacementEntry,
      )}\n`,
      "utf8",
    );

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getSessionId()).toBe("replacement-session");
      expect(reopened.getEntries()).toEqual([replacementEntry]);
      expect(parseCount).toBeGreaterThanOrEqual(2);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("revalidates a transcript changed while the initial load is parsing", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const replacementEntry = buildMessageEntry(2, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );
    const replacementContent =
      `${JSON.stringify(buildSessionHeader(dir, "intermediate-session"))}\n` +
      `${JSON.stringify(replacementEntry)}\n`;
    const finalEntry = buildMessageEntry(3, null);
    const finalContent =
      `${JSON.stringify(buildSessionHeader(dir, "replacement-session"))}\n` +
      `${JSON.stringify(finalEntry)}\n`;

    const originalParse = JSON.parse;
    let replacementCount = 0;
    JSON.parse = function replaceDuringParse(...args: Parameters<typeof JSON.parse>) {
      const parsed = originalParse.apply(originalParse, args);
      if (replacementCount === 0) {
        replacementCount += 1;
        writeFileSync(sessionFile, replacementContent, "utf8");
      } else if (replacementCount === 1 && args[0].includes("intermediate-session")) {
        replacementCount += 1;
        writeFileSync(sessionFile, finalContent, "utf8");
      }
      return parsed;
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getSessionId()).toBe("replacement-session");
      expect(reopened.getEntries()).toEqual([finalEntry]);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("does not cache manager entries over a same-length external replacement", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const replacementEntry = {
      ...buildMessageEntry(2, null),
      id: firstEntry.id,
    };
    const header = buildSessionHeader(dir);
    const originalContent = `${JSON.stringify(header)}\n${JSON.stringify(firstEntry)}\n`;
    const replacementContent = `${JSON.stringify(header)}\n${JSON.stringify(replacementEntry)}\n`;
    expect(Buffer.byteLength(replacementContent)).toBe(Buffer.byteLength(originalContent));
    await fs.writeFile(sessionFile, originalContent, "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await fs.writeFile(sessionFile, replacementContent, "utf8");
    sessionManager.syncSnapshotAfterHeaderRewrite();

    expect(
      SessionManager.open(sessionFile, dir, dir)
        .getEntries()
        .map((entry) => readMessageContent(entry)),
    ).toEqual(["message 2"]);
  });

  it("does not publish a header rewrite snapshot when the expected bytes do not match", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const header = buildSessionHeader(dir);
    const originalContent = `${JSON.stringify(header)}\n${JSON.stringify(buildMessageEntry(1, null))}\n`;
    const replacementContent = `${JSON.stringify(header)}\n${JSON.stringify(
      buildMessageEntry(2, null),
    )}\n`;
    await fs.writeFile(sessionFile, originalContent, "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    const publishSessionFileSnapshot = vi.fn(() => true);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        publishSessionFileSnapshot,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        await fs.writeFile(sessionFile, replacementContent, "utf8");
        sessionManager.syncSnapshotAfterHeaderRewrite(originalContent);
      },
    );

    expect(publishSessionFileSnapshot).not.toHaveBeenCalled();
    expect(
      SessionManager.open(sessionFile, dir, dir)
        .getEntries()
        .map((entry) => readMessageContent(entry)),
    ).toEqual(["message 2"]);
  });

  it("does not persist caller-side entry mutations into warm cache hits", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const opened = SessionManager.open(sessionFile, dir, dir);
    const returnedEntry = opened.getEntries()[0];
    if (!returnedEntry || returnedEntry.type !== "message") {
      throw new Error("expected message entry");
    }
    expect(() => {
      (returnedEntry.message as { content: unknown }).content = "mutated only in caller";
    }).toThrow(TypeError);

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getEntries().map((entry) => readMessageContent(entry))).toEqual([
        "message 1",
      ]);
      expect(parseCount).toBe(0);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("keeps current-version entries immutable when the transcript exceeds the cache limit", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const hugeEntry = buildMessageEntry(1, null);
    if (hugeEntry.type !== "message") {
      throw new Error("expected message entry fixture");
    }
    (hugeEntry.message as { content: string }).content = "x".repeat(33 * 1024 * 1024);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(hugeEntry)}\n`,
      "utf8",
    );

    const opened = SessionManager.open(sessionFile, dir, dir);
    const returnedEntry = opened.getEntries()[0];
    if (!returnedEntry || returnedEntry.type !== "message") {
      throw new Error("expected message entry");
    }

    expect(() => {
      (returnedEntry.message as { content: unknown }).content = "mutated";
    }).toThrow(TypeError);
  });

  it("invalidates the warm cache when another writer appends before this manager persists", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const externalEntry = buildMessageEntry(2, firstEntry.id);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await fs.appendFile(sessionFile, `${JSON.stringify(externalEntry)}\n`, "utf8");
    sessionManager.appendMessage(buildAssistantMessage("message 3"));

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getEntries().map((entry) => readMessageContent(entry))).toEqual([
        "message 1",
        "message 2",
        "message 3",
      ]);
      expect(parseCount).toBeGreaterThanOrEqual(4);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("lets prepareSessionManagerForRun normalize a warm-cached header without re-parsing", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "assistant", content: "carried context" },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir, "original-session"))}\n${JSON.stringify(
        assistantEntry,
      )}\n`,
      "utf8",
    );

    // Warm the process-level entry cache.
    expect(SessionManager.open(sessionFile, dir, dir).getSessionId()).toBe("original-session");

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      // Two warm hits off the same cache entry: must not re-parse the transcript.
      const sessionManager = SessionManager.open(sessionFile, dir, dir);
      const sibling = SessionManager.open(sessionFile, dir, dir);
      expect(parseCount).toBe(0);

      // The embedded runner normalizes the loaded header in place. With a shared
      // frozen cache entry this threw "Cannot assign to read only property".
      await expect(
        prepareSessionManagerForRun({
          sessionManager,
          sessionFile,
          hadSessionFile: true,
          sessionId: "run-session",
          cwd: "/tmp/task-repo",
        }),
      ).resolves.toBeUndefined();

      expect(sessionManager.getSessionId()).toBe("run-session");
      expect(sessionManager.getHeader()).toEqual(
        expect.objectContaining({ type: "session", id: "run-session", cwd: "/tmp/task-repo" }),
      );
      expect(sessionManager.getCwd()).toBe("/tmp/task-repo");

      // Each warm hit gets an independent mutable header clone, so normalizing
      // one manager's header must not bleed into the cached snapshot shared with
      // the sibling manager.
      expect(sibling.getHeader()).toEqual(
        expect.objectContaining({ type: "session", id: "original-session", cwd: dir }),
      );

      // The warm hits stayed parse-free. The required header rewrite parses
      // its two persisted lines once so the cache matches JSON round-tripping.
      expect(parseCount).toBe(2);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("keeps the warm cache after prepareSessionManagerForRun rewrites then appends", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "assistant", content: "carried context" },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir, "original-session"))}\n${JSON.stringify(
        assistantEntry,
      )}\n`,
      "utf8",
    );

    // Warm the process-level entry cache, then open the manager the embedded
    // runner will normalize.
    expect(SessionManager.open(sessionFile, dir, dir).getSessionId()).toBe("original-session");
    const sessionManager = SessionManager.open(sessionFile, dir, dir);

    let trustedSnapshot = await readTrustedRepairSnapshot(sessionFile);
    let snapshotPublications = 0;
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: (snapshot) => {
          expect(snapshot).toEqual(trustedSnapshot);
          return true;
        },
        publishSessionFileSnapshot: (snapshot) => {
          snapshotPublications += 1;
          trustedSnapshot = snapshot;
          return true;
        },
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        await prepareSessionManagerForRun({
          sessionManager,
          sessionFile,
          hadSessionFile: true,
          sessionId: "run-session",
          cwd: dir,
        });
        // First append after the embedded header rewrite. Before the fix the
        // stale snapshot made this drop the warm cache.
        sessionManager.appendMessage(buildAssistantMessage("after rewrite"));
      },
    );
    expect(snapshotPublications).toBe(2);

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getEntries().map((entry) => readMessageContent(entry))).toEqual([
        "carried context",
        "after rewrite",
      ]);
      // The next warm open must hit the cache instead of reparsing the whole
      // transcript that the embedded header rewrite produced.
      expect(parseCount).toBe(0);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("invalidates incremental repair state after a full header rewrite", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );
    await repairSessionFileIfNeeded({ sessionFile });

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile,
      hadSessionFile: true,
      sessionId: "longer-rewritten-session-id",
      cwd: dir,
    });

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;
    try {
      await repairSessionFileIfNeeded({
        sessionFile,
        trustedSnapshot: await readTrustedRepairSnapshot(sessionFile),
      });
      expect(parseCount).toBeGreaterThanOrEqual(2);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("does not rewrite a warm transcript when its header already matches the run", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "assistant", content: "carried context" },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(assistantEntry)}\n`,
      "utf8",
    );
    await fs.utimes(sessionFile, new Date(1_000), new Date(1_000));
    const before = await fs.stat(sessionFile);
    const sessionManager = SessionManager.open(sessionFile, dir, dir);

    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile,
      hadSessionFile: true,
      sessionId: "test-session",
      cwd: dir,
    });

    const after = await fs.stat(sessionFile);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

function readMessageContent(entry: SessionEntry): unknown {
  const content = (entry as { message: { content: unknown } }).message.content;
  if (Array.isArray(content)) {
    return content.map((part) => (part as { text?: string }).text ?? "").join("");
  }
  return content;
}

async function readTrustedRepairSnapshot(sessionFile: string) {
  const stat = await fs.stat(sessionFile, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function buildSessionHeader(cwd: string, id = "test-session") {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp: "2026-06-04T00:00:00.000Z",
    cwd,
  };
}

function buildMessageEntry(index: number, parentId: string | null): SessionEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId,
    timestamp: `2026-06-04T00:00:0${index}.000Z`,
    message: { role: "user", content: `message ${index}`, timestamp: index },
  };
}
