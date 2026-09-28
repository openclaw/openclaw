import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAttemptPaths,
  createAttemptParams,
  createAttemptThreadStarter,
  readHarnessMessages,
} from "./attempt-startup.test-support.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { resetCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { clearSharedCodexAppServerClientAndWait } from "./shared-client.js";
import { createCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";

const tempRoots = new Set<string>();
const startThreadWithHarness = createAttemptThreadStarter(tempRoots, {
  appServer: { command: "codex" },
});

describe("Codex attempt authentication readiness", () => {
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

  it("checks a reused account before resume and recovers the saved thread after sign-in", async () => {
    const paths = createAttemptPaths(tempRoots);
    let signedIn = true;
    let accountVisible = true;
    const respond = (method: string, requestParams?: unknown) => {
      if (method === "account/read") {
        if ((requestParams as { refreshToken?: boolean }).refreshToken) {
          accountVisible = signedIn;
        }
        return {
          account:
            accountVisible && signedIn
              ? { type: "chatgpt", email: "fixture@example.test", planType: "plus" }
              : null,
          requiresOpenaiAuth: true,
        };
      }
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult("saved-thread");
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const first = createCodexLifecycleHarness({ respond });
    const recovered = createCodexLifecycleHarness({ respond, persistedThreads: ["saved-thread"] });
    const start = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(recovered.client);
    const common = { paths, harness: first, skipStartSpy: true };
    const previous = await startThreadWithHarness(5_000, undefined, common).run;
    await first.endTurn(previous.thread.threadId);
    previous.turnRoute.release();
    previous.releaseSharedClientLease();

    signedIn = false;
    const before = first.writes.length;
    await expect(startThreadWithHarness(5_000, undefined, common).run).rejects.toMatchObject({
      status: 401,
      code: "codex_auth_required",
    });
    expect(readHarnessMessages(first.writes.slice(before)).map(({ method }) => method)).toEqual([
      "account/read",
      "account/read",
    ]);
    expect(start).toHaveBeenCalledTimes(1);

    signedIn = true;
    const continued = await startThreadWithHarness(5_000, undefined, {
      ...common,
      harness: recovered,
    }).run;
    expect(continued.thread.threadId).toBe(previous.thread.threadId);
    expect(
      readHarnessMessages(recovered.writes)
        .filter(({ method }) => method === "account/read")
        .slice(0, 2)
        .map(({ params }) => params),
    ).toEqual([{ refreshToken: false }, { refreshToken: true }]);
    expect(start).toHaveBeenCalledTimes(2);
    continued.turnRoute.release();
    continued.releaseSharedClientLease();
  });

  it.each([
    { provider: "codex", modelId: "gpt-5.4-codex", nativeAuthRequired: false },
    { provider: "lmstudio", modelId: "gpt-5.4-codex", nativeAuthRequired: true },
    { provider: "codex", modelId: "lmstudio/gpt-5.4-codex", nativeAuthRequired: true },
  ])(
    "starts accountless $provider/$modelId with nativeAuthRequired=$nativeAuthRequired",
    async ({ provider, modelId, nativeAuthRequired }) => {
      const paths = createAttemptPaths(tempRoots);
      const harness = createCodexLifecycleHarness({
        respond: (method, requestParams) => {
          if (method === "account/read") {
            return { account: null, requiresOpenaiAuth: nativeAuthRequired };
          }
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "thread/start") {
            const response = threadStartResult();
            const { modelProvider } = requestParams as { modelProvider?: string };
            return {
              ...response,
              modelProvider: modelProvider ?? response.modelProvider,
              thread: {
                ...response.thread,
                modelProvider: modelProvider ?? response.modelProvider,
              },
            };
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      const result = await startThreadWithHarness(5_000, undefined, {
        harness,
        paths,
        buildAttemptParams: () => ({ ...createAttemptParams(paths), provider, modelId }),
      }).run;
      expect(result.thread.threadId).toBe("thread-1");
      expect(result.thread.modelProvider).toBe(nativeAuthRequired ? "lmstudio" : "openai");
      result.turnRoute.release();
      result.releaseSharedClientLease();
    },
  );
});
