import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import { maybeCompactCodexAppServerSession } from "./compact.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import {
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retainSharedCodexAppServerClientIfCurrent,
  retireSharedCodexAppServerClientIfCurrent,
  resetSharedCodexAppServerClientForTests,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

let directory: string | undefined;
const transports: ReturnType<typeof createClientHarness>[] = [];

afterEach(async () => {
  resetSharedCodexAppServerClientForTests();
  await Promise.all(transports.splice(0).map(({ client }) => client.closeAndWait()));
  resetCodexTestBindingStore();
  vi.restoreAllMocks();
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

it.each(["warm", "closed", "detached", "unconfirmed-close"])(
  "supports repeated compaction and the next turn (owner %s)",
  async (ownerState) => {
    const ownerClosed = ownerState === "closed" || ownerState === "unconfirmed-close";
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-compact-owner-")));
    const agentDir = path.join(directory, "agent");
    const sessionFile = path.join(directory, "session.jsonl");
    const sessionKey = "agent:main:compact-owner";
    const pluginConfig = {
      appServer: { command: process.execPath, args: ["app-server"], homeScope: "user" },
    };
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig,
      codexConfigToml: null,
      requirementsToml: null,
    });
    const owners = new Map<string, number>();
    const operations: { client: number; method: string; threadId?: string }[] = [];
    vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
      const index = transports.length;
      const harness = createClientHarness({
        onWrite(line, send) {
          const request = JSON.parse(line) as {
            id?: number;
            method: string;
            params?: { threadId?: string };
          };
          if (request.id === undefined) {
            return;
          }
          const threadId = request.params?.threadId;
          operations.push({ client: index, method: request.method, threadId });
          if (request.method === "initialize") {
            send({
              id: request.id,
              result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}`, codexHome: directory },
            });
            return;
          }
          // Codex's thread_resume cross-process contract retains the writer after turn completion.
          if (
            request.method === "thread/resume" &&
            threadId &&
            owners.has(threadId) &&
            owners.get(threadId) !== index
          ) {
            send({
              id: request.id,
              error: { code: -32600, message: `thread ${threadId} already has an active writer` },
            });
            return;
          }
          if (request.method === "thread/resume" && threadId) {
            owners.set(threadId, index);
            send({
              id: request.id,
              result: {
                thread: {
                  id: threadId,
                  turns: [],
                  cwd: directory,
                  sessionId: "session-1",
                  cliVersion: CODEX_APP_SERVER_VERSION,
                  createdAt: 1,
                  updatedAt: 1,
                  ephemeral: false,
                  modelProvider: "openai",
                  preview: "",
                  projectId: null,
                  source: "unknown",
                  status: { type: "idle" },
                },
                model: "gpt-5.6-luna",
                modelProvider: "openai",
                cwd: directory,
                approvalPolicy: "never",
                approvalsReviewer: "user",
                sandbox: { type: "dangerFullAccess" },
              },
            });
            return;
          }
          // Unsubscribe stops notifications, but Codex keeps the writer until idle eviction or exit.
          if (
            (request.method === "turn/start" || request.method === "thread/compact/start") &&
            threadId
          ) {
            const turn = { id: "finished-turn", threadId, status: "completed" };
            if (request.method === "thread/compact/start") {
              send({
                method: "turn/started",
                params: { threadId, turn: { ...turn, status: "inProgress" } },
              });
              send({
                method: "item/started",
                params: {
                  threadId,
                  turnId: turn.id,
                  item: { id: "compacted", type: "contextCompaction" },
                },
              });
              send({
                method: "item/completed",
                params: {
                  threadId,
                  turnId: turn.id,
                  item: { id: "compacted", type: "contextCompaction" },
                },
              });
            }
            send({ method: "turn/completed", params: { threadId, turn } });
            send({ id: request.id, result: request.method === "turn/start" ? { turn } : {} });
            return;
          }
          send({ id: request.id, result: {} });
        },
      });
      harness.client.addTransportExitHandler(() => {
        for (const [threadId, ownerIndex] of owners) {
          if (ownerIndex === index) {
            owners.delete(threadId);
          }
        }
      });
      transports.push(harness);
      if (ownerState === "unconfirmed-close" && index === 1) {
        vi.spyOn(harness.client, "closeAndWait").mockResolvedValueOnce({
          exited: false,
          cleanup: "uncertain",
        });
      }
      return harness.client;
    });
    const owner = await getLeasedSharedCodexAppServerClient({
      startOptions: {
        ...runtime.start,
        env: { ...runtime.start.env, COMPACTION_TEST_SHELL: "prepared" },
      },
      agentDir,
      authProfileId: null,
    });
    await owner.request(
      "thread/resume",
      { threadId: "owned-thread", excludeTurns: true },
      { timeoutMs: 1000 },
    );
    await owner.request("turn/start", { threadId: "owned-thread", input: [] }, { timeoutMs: 1000 });
    await retainCodexAppServerLiveThread(owner, "owned-thread");
    await owner.request(
      "thread/resume",
      { threadId: "sibling-thread", excludeTurns: true },
      { timeoutMs: 1000 },
    );
    await retainCodexAppServerLiveThread(owner, "sibling-thread");
    registerCodexTestSessionIdentity(sessionFile, "session-1", sessionKey, "main");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "owned-thread",
      cwd: directory,
      clientId: owner.getInstanceId(),
    });
    releaseLeasedSharedCodexAppServerClient(owner);
    const releaseSiblingLease =
      ownerState === "detached" ? retainSharedCodexAppServerClientIfCurrent(owner) : undefined;
    if (ownerState === "detached") {
      expect(releaseSiblingLease).toBeDefined();
      expect(retireSharedCodexAppServerClientIfCurrent(owner)?.closed).toBe(false);
    }
    if (ownerClosed) {
      expect(await owner.closeAndWait()).toMatchObject({ exited: true });
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const compaction = maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey,
          sessionFile,
          agentDir,
          workspaceDir: directory,
          trigger: "manual",
        },
        { bindingStore: testCodexAppServerBindingStore, pluginConfig },
      );

      if (ownerState === "unconfirmed-close") {
        await expect(compaction).rejects.toThrow("Codex compaction client did not exit");
        expect(owners.get("owned-thread")).toBe(1);
        expect(operations.some(({ method }) => method === "thread/compact/start")).toBe(true);
        return;
      }
      const result = await compaction;
      expect(result, JSON.stringify({ result, operations })).toMatchObject({
        ok: true,
        compacted: true,
      });
      expect(owners.get("owned-thread")).toBe(ownerClosed ? undefined : 0);
      expect(owners.get("sibling-thread")).toBe(ownerClosed ? undefined : 0);
    }
    expect(operations.filter(({ method }) => method === "thread/compact/start")).toEqual([
      { client: ownerClosed ? 1 : 0, method: "thread/compact/start", threadId: "owned-thread" },
      { client: ownerClosed ? 2 : 0, method: "thread/compact/start", threadId: "owned-thread" },
    ]);
    if (!ownerClosed) {
      expect(await consumeCodexAppServerLiveThread(owner, "owned-thread")).toBeDefined();
      expect(await consumeCodexAppServerLiveThread(owner, "sibling-thread")).toBeDefined();
    }
    const nextOwner =
      ownerState === "detached"
        ? owner
        : await getLeasedSharedCodexAppServerClient({
            startOptions: {
              ...runtime.start,
              env: { ...runtime.start.env, COMPACTION_TEST_SHELL: "prepared" },
            },
            agentDir,
            authProfileId: null,
          });
    try {
      await nextOwner.request(
        "thread/resume",
        { threadId: "owned-thread", excludeTurns: true },
        { timeoutMs: 1000 },
      );
      await expect(
        nextOwner.request(
          "turn/start",
          { threadId: "owned-thread", input: [] },
          { timeoutMs: 1000 },
        ),
      ).resolves.toMatchObject({ turn: { status: "completed" } });
    } finally {
      if (releaseSiblingLease) {
        releaseSiblingLease();
      } else {
        releaseLeasedSharedCodexAppServerClient(nextOwner);
      }
    }
  },
);
