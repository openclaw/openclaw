import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexThread } from "./app-server/protocol.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const createdAt = Date.parse("2026-09-16T12:00:00.000Z") / 1_000;
const line = (type: string, payload: unknown) => `${JSON.stringify({ type, payload })}\n`;
const indexes: CodexCatalogIndex[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(async () => {
  for (const index of indexes.splice(0)) {
    await index.close();
  }
  vi.useRealTimers();
});

function catalog(
  root: string,
  data: CodexThread[],
  options: { homeId?: string; local?: boolean } = {},
) {
  const readNative = vi.fn(async () =>
    projectCodexCatalogPage({ data }, { sanitize: sanitizeTerminalText }),
  );
  const index = new CodexCatalogIndex({
    homeId: options.homeId ?? root,
    ...(options.local === false ? {} : { localSessionsRoot: root }),
    readNative,
    assertCurrent: () => {},
  });
  indexes.push(index);
  return { index, readNative };
}

function rolloutContents(thread: CodexThread): string {
  return (
    line("session_meta", {
      id: thread.id,
      timestamp: new Date((thread.createdAt ?? createdAt) * 1_000).toISOString(),
      cwd: thread.cwd,
      source: thread.source,
      originator: "codex_cli_rs",
      session_id: thread.sessionId,
      model_provider: thread.modelProvider,
      cli_version: thread.cliVersion,
      git: thread.gitInfo,
    }) +
    line("event_msg", { type: "user_message", message: thread.preview }) +
    line("event_msg", { type: "agent_message", message: "x".repeat(256 * 1024) })
  );
}

async function fixture() {
  const root = path.join(tempDirs.make("codex-native-authority-"), "sessions");
  const day = path.join(root, "2026", "09", "16");
  await fs.mkdir(day, { recursive: true });
  const file = path.join(day, "rollout-authority.jsonl");
  const thread: CodexThread = {
    id: "authority",
    projectId: null,
    path: file,
    name: null,
    preview: "Please preserve the current native workspace and catalog metadata.",
    source: "cli",
    originator: "codex_cli_rs",
    cwd: "/workspace/rollout-original",
    modelProvider: "rollout-provider",
    sessionId: "rollout-session",
    cliVersion: "0.100.0",
    gitInfo: { branch: "rollout-branch" },
    createdAt,
    updatedAt: createdAt + 100,
  };
  await fs.writeFile(file, rolloutContents(thread));
  await fs.utimes(file, createdAt + 100, createdAt + 100);
  return { root, file, thread };
}

describe("native catalog metadata authority", () => {
  it.each([null, createdAt + 100])(
    "moves a file-observed turn ahead of a native timestamp tie (previous recency: %s)",
    async (recencyAt) => {
      const { root, file, thread } = await fixture();
      const native = {
        ...thread,
        recencyAt,
        updatedAt: recencyAt === null ? createdAt + 100 : createdAt + 400,
      };
      const peer = { ...native, id: "newer-peer", path: undefined, recencyAt: createdAt + 200 };
      const { index, readNative } = catalog(root, [peer, native]);
      await index.initialize();
      expect((await index.list({})).sessions.map((row) => row.threadId)).toEqual([
        peer.id,
        native.id,
      ]);
      await fs.appendFile(
        file,
        line("event_msg", {
          type: "turn_started",
          turn_id: "new-turn",
          started_at: createdAt + 200,
        }),
      );
      await fs.utimes(file, createdAt + 500, createdAt + 500);
      await index.reconcile();
      const current = await index.list({ limit: 1 });
      expect(current.sessions[0]).toMatchObject({
        threadId: native.id,
        recencyAt: createdAt + 200,
        updatedAt: native.updatedAt,
      });
      expect(current.nextCursor).toBeDefined();
      await fs.utimes(file, createdAt + 600, createdAt + 600);
      await index.reconcile();
      expect(await index.list({ limit: 1 })).toEqual(current);
      expect(readNative).toHaveBeenCalledOnce();
    },
  );

  it("refreshes the selected file's preview without replacing native workspace metadata", async () => {
    const { root, file, thread } = await fixture();
    const native = {
      ...thread,
      cwd: "/workspace/native",
      preview: "Previous first request",
      updatedAt: createdAt + 300,
    };
    const { index, readNative } = catalog(root, [native]);
    await index.initialize();
    await fs.writeFile(
      file,
      rolloutContents({ ...thread, preview: "New first user request in the selected file" }),
    );
    await fs.utimes(file, createdAt + 400, createdAt + 400);
    await index.reconcile();
    expect((await index.list({ searchTerm: "new first" })).sessions[0]).toMatchObject({
      cwd: "/workspace/native",
      updatedAt: createdAt + 300,
      fallbackName: "New first user request in the selected file",
    });
    expect(readNative).toHaveBeenCalledOnce();
  });

  it("honors an explicit native preview clear instead of restoring its previous fallback", async () => {
    const { root, thread } = await fixture();
    const { index } = catalog(root, [thread], { local: false });
    await index.initialize();
    expect((await index.list({})).sessions[0]?.fallbackName).toBe(thread.preview);
    await index.upsertThread({ ...thread, preview: "" });
    expect((await index.list({})).sessions[0]).not.toHaveProperty("fallbackName");
    expect(index.get(thread.id)?.preview).toBe("");
  });

  it("keeps native selections and fallback ordering when an old rollout is touched", async () => {
    const { root, file, thread } = await fixture();
    const native: CodexThread = {
      ...thread,
      cwd: "/workspace/native-selected",
      modelProvider: "native-provider",
      source: "vscode",
      sessionId: "native-session",
      cliVersion: "0.155.0",
      gitInfo: { branch: "native-branch" },
      createdAt: createdAt + 10,
      updatedAt: createdAt + 300,
      recencyAt: null,
    };
    const peer: CodexThread = {
      ...native,
      id: "newer-peer",
      path: undefined,
      updatedAt: createdAt + 400,
    };
    const { index, readNative } = catalog(root, [peer, native]);
    const selected = {
      threadId: "authority",
      cwd: "/workspace/native-selected",
      modelProvider: "native-provider",
      source: "vscode",
      sessionId: "native-session",
      cliVersion: "0.155.0",
      gitBranch: "native-branch",
      createdAt: createdAt + 10,
      updatedAt: createdAt + 300,
    };
    await index.initialize();
    await index.reconcile();
    expect((await index.list({})).sessions.map((row) => row.threadId)).toEqual([
      "newer-peer",
      "authority",
    ]);

    await fs.utimes(file, createdAt + 500, createdAt + 500);
    await index.reconcile();
    const touched = await index.list({});
    expect(touched.sessions.map((row) => row.threadId)).toEqual(["newer-peer", "authority"]);
    expect(touched.sessions[1]).toMatchObject(selected);
    expect((await index.list({ cwd: selected.cwd })).sessions).toEqual(touched.sessions);

    await fs.appendFile(
      file,
      line("event_msg", {
        type: "turn_started",
        turn_id: "new-turn",
        started_at: createdAt + 450,
      }),
    );
    await fs.utimes(file, createdAt + 600, createdAt + 600);
    await index.reconcile();
    const started = await index.list({});
    expect(started.sessions.map((row) => row.threadId)).toEqual(["authority", "newer-peer"]);
    expect(started.sessions[0]).toMatchObject({ ...selected, recencyAt: createdAt + 450 });
    expect(index.get("authority")).toMatchObject({
      nativeMetadata: true,
      updatedAt: createdAt + 300,
      recencyAt: createdAt + 450,
    });
    expect(readNative).toHaveBeenCalledOnce();
  });

  it("updates provisional file metadata until a native upsert selects its authoritative values", async () => {
    const { root, file, thread } = await fixture();
    const { index, readNative } = catalog(root, []);
    await index.initialize();
    await index.reconcile();
    expect((await index.list({})).sessions[0]).toMatchObject({
      cwd: "/workspace/rollout-original",
      source: "cli",
      sessionId: "rollout-session",
    });

    await fs.writeFile(
      file,
      rolloutContents({
        ...thread,
        cwd: "/workspace/rollout-moved",
        source: "vscode",
        sessionId: "rollout-replaced-session",
        createdAt: createdAt + 20,
      }),
    );
    await fs.utimes(file, createdAt + 200, createdAt + 200);
    await index.reconcile();
    expect((await index.list({ cwd: "/workspace/rollout-moved" })).sessions[0]).toMatchObject({
      source: "vscode",
      sessionId: "rollout-replaced-session",
      createdAt: createdAt + 20,
      updatedAt: createdAt + 200,
    });
    const provisional = index.get("authority");

    await index.upsertThread({
      ...thread,
      cwd: "/workspace/native-promoted",
      source: "cli",
      sessionId: "native-promoted-session",
      createdAt: createdAt + 30,
      updatedAt: createdAt + 300,
    });
    await fs.appendFile(file, line("event_msg", { type: "agent_message", message: "More output" }));
    await fs.utimes(file, createdAt + 400, createdAt + 400);
    await index.reconcile();
    expect((await index.list({})).sessions[0]).toMatchObject({
      cwd: "/workspace/native-promoted",
      source: "cli",
      sessionId: "native-promoted-session",
      createdAt: createdAt + 30,
      updatedAt: createdAt + 300,
    });
    expect((await index.list({ cwd: "/workspace/rollout-moved" })).sessions).toEqual([]);
    expect(provisional).toMatchObject({ nativeMetadata: false });
    expect(index.get("authority")).toMatchObject({ nativeMetadata: true });
    expect(readNative).toHaveBeenCalledOnce();
  });
});
