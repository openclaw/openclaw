import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerInitialize,
  createAttemptPaths,
  createAttemptClientHarness,
  createAttemptThreadStarter,
  readHarnessRequestMethods,
  waitForRequest,
  waitForThreadStart,
} from "./attempt-startup.test-support.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult as createThreadStartResult } from "./codex-app-server.test-fixtures.js";
import { type CodexPluginConfig, resolveCodexAppServerRuntimeOptions } from "./config.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";

vi.mock("./desktop-generation.js", () => ({
  isCodexDesktopGenerationCurrent: () => false,
  waitForCodexDesktopGeneration: async () => undefined,
}));

const tempRoots = new Set<string>();
const pluginConfig: CodexPluginConfig = { appServer: { command: "codex" } };
const startThreadWithHarness = createAttemptThreadStarter(tempRoots, pluginConfig);
const threadStartResult = (threadId = "thread-1") => createThreadStartResult(threadId, "/repo");

describe("startup cancellation with a healthy peer and replacement attempt", () => {
  beforeEach(async () => {
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(undefined);
    defaultCodexPluginMetadataCache.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it("retires indeterminate thread startup while another leased peer completes", async () => {
    const retained = createAttemptClientHarness();
    const replacement = createAttemptClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(retained.client)
      .mockResolvedValueOnce(replacement.client);
    const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
    const paths = createAttemptPaths(tempRoots);

    const retainedLease = getLeasedSharedCodexAppServerClient({
      startOptions: appServer.start,
      agentDir: paths.agentDir,
    });
    await answerInitialize(retained);
    await expect(retainedLease).resolves.toBe(retained.client);

    const peer = retained.client.request("turn/start", { threadId: "healthy-peer" });
    const peerStart = await waitForRequest(retained, "turn/start");
    const { run } = startThreadWithHarness(100, new AbortController().signal, {
      harness: retained,
      paths,
      skipStartSpy: true,
    });
    const rejected = expect(run).rejects.toThrow("codex app-server startup timed out");
    const threadStart = await waitForThreadStart(retained);

    await rejected;
    expect(threadStart.id).toBeDefined();
    expect(retained.process.stdin.destroyed).toBe(false);
    const replacementRun = startThreadWithHarness(5_000, new AbortController().signal, {
      harness: replacement,
      paths,
      skipStartSpy: true,
    }).run;
    await answerInitialize(replacement);
    const mutate = vi.spyOn(testCodexAppServerBindingStore, "mutate");
    retained.send({ id: threadStart.id, result: threadStartResult("replacement-thread") });
    retained.send({
      method: "thread/started",
      params: { thread: threadStartResult("replacement-thread").thread },
    });
    const replacementStart = await waitForThreadStart(replacement);
    expect(mutate).not.toHaveBeenCalled();
    replacement.send({ id: replacementStart.id, result: threadStartResult("replacement-thread") });
    const replacementAttempt = await replacementRun;
    const binding = testCodexAppServerBindingStore.read({
      kind: "session",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
    });
    expect(binding?.threadId).toBe("replacement-thread");
    const writesAfterReplacement = mutate.mock.calls.length;
    const tool = vi.fn(() => ({ success: true }));
    await replacementAttempt.turnRoute.activate({ onRequest: tool });
    const toolRequest = {
      method: "item/tool/call",
      params: { threadId: "replacement-thread", turnId: "replacement-turn", tool: "message" },
    };
    retained.send({ id: threadStart.id, result: threadStartResult("replacement-thread") });
    retained.send({
      method: "thread/started",
      params: { thread: threadStartResult("replacement-thread").thread },
    });
    retained.send({ id: "stale-tool", ...toolRequest });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await replacementAttempt.turnRoute.drain();
    expect(tool).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledTimes(writesAfterReplacement);
    expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
      }),
    ).toEqual(binding);
    expect(readHarnessRequestMethods(replacement)).not.toContain("thread/unsubscribe");
    expect(readHarnessRequestMethods(replacement)).not.toContain("turn/start");
    // Positive route control: only the authoritative client's tool request runs.
    replacement.send({ id: "current-tool", ...toolRequest });
    await vi.waitFor(() => expect(tool).toHaveBeenCalledTimes(1));
    retained.send({ id: peerStart.id, result: { turn: { id: "healthy-turn" } } });
    await expect(peer).resolves.toEqual({ turn: { id: "healthy-turn" } });
    expect(retained.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(retained.client)).toBe(true);
    expect(retained.process.stdin.destroyed).toBe(true);
    expect(replacement.process.stdin.destroyed).toBe(false);
    replacementAttempt.turnRoute.release();
    replacementAttempt.releaseSharedClientLease();
  });
});
