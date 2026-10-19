import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toGenericTranscriptItem } from "../session-catalog-transcript-item.js";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import type { CodexThread, CodexThreadItem, CodexTurn } from "./protocol.js";
import { sessionBindingIdentity } from "./session-binding.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { importCodexThreadHistoryToTranscript } from "./transcript-mirror.js";
import { resolveCodexUpstreamForkBoundary } from "./upstream-fork-boundary.js";
import { forkCodexUpstreamSession } from "./upstream-session-fork.js";
import {
  codexForkTurn,
  createForkTestRuntime,
  forkControl,
  forkParams,
  forkResponse,
} from "./upstream-session-fork.test-support.js";

vi.mock("openclaw/plugin-sdk/session-catalog", async (importOriginal) => ({
  ...(await importOriginal()),
  deleteSessionUpstreamLinkAsync: vi.fn(),
  upsertSessionUpstreamLinkAsync: vi.fn(() => true),
}));

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await closeOpenClawAgentDatabasesAsync(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function turn(id: string, texts: string[]): CodexTurn {
  const user: CodexThreadItem = {
    ...codexForkTurn(id, "").items[0]!,
    content: texts.map((text) => ({ type: "text", text, text_elements: [] })),
  };
  return {
    id,
    status: "completed",
    items: [
      user,
      { ...user, id: `${id}-assistant`, type: "agentMessage", content: [], text: "Answer" },
    ],
  };
}

async function importHistory(turns: CodexTurn[], name?: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-fork-import-")));
  roots.push(root);
  const target = {
    agentId: "main",
    sessionId: "imported-session",
    sessionKey: "agent:main:imported-session",
    storePath: path.join(root, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: {
      sessionFile: `sqlite:${target.agentId}:${target.sessionId}:${target.storePath}`,
      sessionId: target.sessionId,
      updatedAt: Date.now(),
      label: name,
    },
  });
  const thread: CodexThread = { id: "thread-source", projectId: null, name, turns };
  const imported = await importCodexThreadHistoryToTranscript({
    ...target,
    thread,
    throughTurnId: turns.at(-1)!.id,
  });
  const entries = await readVisibleSessionTranscriptMessageEntries(target);
  const users = entries.filter((entry) => entry.role === "user");
  const selected = users.at(-1);
  expect(selected).toBeDefined();
  const control = {
    readThread: vi.fn(async () => thread),
    listTurnPage: vi.fn<CodexSessionCatalogControl["listTurnPage"]>(async ({ cursor, limit }) => {
      const allTurns = thread.turns ?? [];
      const offset = Number(cursor ?? 0);
      const next = offset + (limit ?? 100);
      return {
        data: allTurns.slice(offset, next),
        ...(next < allTurns.length ? { nextCursor: String(next) } : {}),
      };
    }),
  } as unknown as CodexSessionCatalogControl;
  return {
    target,
    thread,
    control,
    imported,
    users,
    resolve: () =>
      resolveCodexUpstreamForkBoundary({
        ...target,
        threadId: thread.id,
        entryId: selected!.entryId,
        control,
      }),
  };
}

describe("fork boundaries from imported Codex history", () => {
  it.each([false, true])(
    "forks a named source without inheriting its unique local label (materialized: %s)",
    async (materialized) => {
      const turns = [turn("turn-1", ["one"]), turn("turn-2", ["edit me"])];
      const name = "Native fork verification";
      const history = await importHistory(turns, name);
      const sourceEntry = getSessionEntry(history.target);
      const sourceEntries = await readVisibleSessionTranscriptMessageEntries(history.target);
      const bindingStore = createCodexTestBindingStore();
      const identity = sessionBindingIdentity(history.target);
      await bindingStore.mutate(identity, {
        kind: "set",
        binding: {
          threadId: materialized ? "thread-canonical" : history.thread.id,
          cwd: "/tmp",
          connectionScope: "supervision",
          supervisionSourceThreadId: history.thread.id,
          preserveNativeModel: true,
          conversationSourceTransferComplete: true,
          ...(materialized
            ? {
                appServerRuntimeFingerprint: "fingerprint",
                model: "gpt-5.6-luna",
                modelProvider: "openai",
              }
            : {
                pendingSupervisionBranch: {
                  sourceThreadId: history.thread.id,
                  connectionFingerprint: "fingerprint",
                  lastTurnId: "turn-2",
                },
              }),
        },
      });
      const sourceBinding = bindingStore.read(identity);
      const response = forkResponse();
      const namedResponse = { ...response, thread: { ...response.thread, name } };
      const nativeThreads = new Map<string, CodexThread>([
        [history.thread.id, history.thread],
        // Injected history is absent from the canonical thread's native projection.
        ["thread-canonical", { id: "thread-canonical", projectId: null, turns: [] }],
        [response.thread.id, { ...namedResponse.thread, turns: turns.slice(0, 1) }],
      ]);
      const sourceBefore = structuredClone(nativeThreads);
      const { control, controlFactory, forkThread, archiveThread } = forkControl(
        vi.fn(async () => namedResponse),
      );
      Object.assign(control, history.control, {
        readThread: async (threadId) => nativeThreads.get(threadId)!,
        listTurnPage: async ({ threadId }: { threadId: string }) => ({
          data: nativeThreads.get(threadId)!.turns ?? [],
        }),
      } satisfies Partial<CodexSessionCatalogControl>);
      const runtime = createForkTestRuntime(history.target.storePath);
      const createSession = vi.mocked(runtime.agent.session.createSessionEntry);
      const targetKey = "agent:main:dashboard:forked";

      const result = await forkCodexUpstreamSession(
        {
          ...forkParams(),
          targetKey,
          source: { ...history.target, entryId: history.users.at(-1)!.entryId },
        },
        {
          bindingStore,
          controlFactory,
          harnessRuntimeId: "codex",
          resolveConfig: () => ({ session: { store: history.target.storePath } }),
          runtime,
        },
      );
      const child = await createSession.mock.results[0]!.value;
      expect(result).toEqual({ status: "created", key: targetKey, editorText: "edit me" });

      expect(forkThread).toHaveBeenCalledExactlyOnceWith(
        {
          threadId: history.thread.id,
          beforeTurnId: "turn-2",
          excludeTurns: true,
        },
        expect.any(Function),
      );
      expect(child.entry.label).toBeUndefined();
      expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty("label");
      expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty("displayName");
      const childEntries = await readVisibleSessionTranscriptMessageEntries({
        ...history.target,
        sessionId: child.sessionId,
        sessionKey: child.key,
      });
      expect(childEntries).toMatchObject([
        { role: "user", message: { content: "one" } },
        { role: "assistant" },
      ]);
      expect(bindingStore.read(identity)).toEqual(sourceBinding);
      expect(getSessionEntry(history.target)).toEqual(sourceEntry);
      expect(getSessionEntry(history.target)?.label).toBe(name);
      expect(await readVisibleSessionTranscriptMessageEntries(history.target)).toEqual(
        sourceEntries,
      );
      expect(namedResponse.thread.name).toBe(name);
      expect(nativeThreads).toEqual(sourceBefore);
      expect(archiveThread).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "surrounding whitespace", texts: ["  first question \n"] },
    { label: "multiple text blocks", texts: ["first block", "second block"] },
    { label: "per-message UTF-8 budget", texts: ["🦞".repeat(20_000)] },
  ])("matches unchanged imported $label", async ({ texts }) => {
    const history = await importHistory([turn("turn-1", texts), turn("turn-2", ["edit me"])]);

    await expect(history.resolve()).resolves.toEqual({
      ok: true,
      editorText: "edit me",
      boundary: { beforeTurnId: "turn-2", lastRetainedTurnId: "turn-1" },
    });
  });

  it.each([
    ["message count", 105, "same question", false],
    ["message count with an earlier image", 105, "same question", true],
    ["total UTF-8 bytes", 12, "🦞".repeat(16_000), false],
  ] as const)(
    "selects the original turn after the %s cap drops an identical-text prefix",
    async (_label, count, text, omittedImage) => {
      // Repeated text makes ordinal misalignment select the wrong valid turn rather than reject.
      const turns = Array.from({ length: count }, (_, index) => turn(`turn-${index}`, [text]));
      if (omittedImage) {
        turns[0]!.items[0]!.content = [
          { type: "localImage", path: "/synthetic/omitted-image.png" },
        ];
      }
      const history = await importHistory(turns);
      expect(history.imported.omittedMessages).toBeGreaterThan(0);
      expect(history.users.length).toBeLessThan(count);

      await expect(history.resolve()).resolves.toEqual({
        ok: true,
        editorText: text,
        boundary: {
          beforeTurnId: `turn-${count - 1}`,
          lastRetainedTurnId: `turn-${count - 2}`,
        },
      });
    },
  );

  it("rejects upstream prefix drift after import even when message identities and target match", async () => {
    const turns = [turn("turn-1", ["original question"]), turn("turn-2", ["edit me"])];
    const history = await importHistory(turns);
    turns[0] = turn("turn-1", ["changed question"]);

    await expect(history.resolve()).resolves.toMatchObject({
      ok: false,
      code: "drift-mismatch",
    });
  });

  it("emits real catalog user text from native content alongside bounded attachment display", () => {
    const item = turn("turn-1", ["  Native user prompt  ", "second block"]).items[0]!;
    expect(toGenericTranscriptItem(item)).toMatchObject({
      type: "userMessage",
      text: "Native user prompt\nsecond block",
    });
    const attachment = {
      ...item,
      content: [{ type: "localImage", path: "/private/image.png" }],
    };
    expect(toGenericTranscriptItem(attachment).text).toBe("[Image attachment]");
  });
});
