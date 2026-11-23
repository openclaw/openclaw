import path from "node:path";
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./app-server/client.js";
import { threadStartResult } from "./app-server/codex-app-server.test-fixtures.js";
import {
  ownCodexInferenceClient,
  getCodexInferenceThread,
} from "./app-server/inference-routing.js";
import {
  createCodexAppServerBindingStore,
  bindingStoreKey,
  type CodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./app-server/session-binding.js";
import { createCodexTestBindingStateStore } from "./app-server/session-binding.test-helpers.js";
import { withCodexAppServerSessionDeletion } from "./app-server/session-retirement.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./app-server/shared-client.js";
import { stubCodexInferenceTransportEnv } from "./app-server/test-support.js";
import {
  createCodexLifecycleHarness,
  createParams,
  createAppServerOptions,
  resetThreadLifecycleTestFixtures,
  startOrResumeThreadWithEmptySkillCatalog,
  writeNativeCatalogFixture,
} from "./app-server/thread-lifecycle.test-fixtures.js";
import { retainCodexAppServerBindingSubscription } from "./app-server/thread-ownership.js";
import { createCodexCommandHost } from "./command-host.test-support.js";
import { createCodexCommand } from "./commands.js";
import {
  createContext,
  createCodexRuntimeContextOverrides,
  useCodexCommandTestState,
} from "./commands.test-support.js";

let tempDir: string;
useCodexCommandTestState({
  onSetup: (root) => {
    tempDir = root;
  },
});
afterEach(resetThreadLifecycleTestFixtures);

it("restores the deleted thread inference route after manual resume without disturbing its sibling", async () => {
  stubCodexInferenceTransportEnv();
  const context = await createCodexRuntimeContextOverrides(tempDir);
  const agentDir = resolveDefaultAgentDir(context.config);
  const codexHome = path.join(agentDir, "codex-home");
  const pluginConfig = { appServer: { command: process.execPath, args: ["app-server"] } };
  const values = new Map<string, StoredCodexAppServerBinding>();
  const storedBindings = createCodexAppServerBindingStore(createCodexTestBindingStateStore(values));
  // The host transaction is a memory adapter; native subscription retirement stays real.
  const bindingStore: CodexAppServerBindingStore = {
    ...storedBindings,
    async withSessionDeletion(identity, assertCurrent, run) {
      const key = bindingStoreKey(identity);
      const record = values.get(key);
      return run(storedBindings.read(identity), {
        commit() {
          assertCurrent();
          values.delete(key);
        },
        rollback() {
          assertCurrent();
          if (record) {
            values.set(key, record);
          }
        },
      });
    },
  };
  let nextThread = 0;
  const responseFor = (threadId: string) => {
    const response = threadStartResult(threadId, tempDir);
    return {
      ...response,
      thread: { ...response.thread, path: path.join(codexHome, "sessions", threadId + ".jsonl") },
    };
  };
  const wire = createCodexLifecycleHarness({
    codexHome,
    respond(method, params) {
      if (method === "thread/start") {
        return responseFor("thread-" + ++nextThread);
      }
      if (
        method === "thread/resume" &&
        params &&
        typeof params === "object" &&
        "threadId" in params &&
        typeof params.threadId === "string"
      ) {
        return responseFor(params.threadId);
      }
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "thread/inject_items") {
        return {};
      }
      throw new Error("Unexpected native method: " + method);
    },
  });
  const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(wire.client);
  const client = await getLeasedSharedCodexAppServerClient({
    pluginConfig,
    config: context.config,
    agentDir,
  });
  ownCodexInferenceClient(client);
  try {
    const params = {
      ...createParams(path.join(tempDir, "session.jsonl"), tempDir),
      ...context,
      agentId: "main",
      agentDir,
      disableTools: false,
    };
    const appServer = createAppServerOptions();
    const common = {
      client,
      bindingStore,
      params,
      appServer,
      cwd: tempDir,
      dynamicTools: [],
      userMcpServersEnabled: false,
      signal: new AbortController().signal,
    };
    const main = await startOrResumeThreadWithEmptySkillCatalog(common);
    await writeNativeCatalogFixture(responseFor(main.threadId).thread.path, main.threadId, []);
    expect(
      await retainCodexAppServerBindingSubscription(
        client,
        main.threadId,
        main.liveThreadOwnership,
      ),
    ).toBe(true);
    const siblingContext = await createCodexRuntimeContextOverrides(tempDir, "agent:main:sibling");
    const siblingParams = { ...params, ...siblingContext };
    const sibling = await startOrResumeThreadWithEmptySkillCatalog({
      ...common,
      params: siblingParams,
    });
    expect(
      await retainCodexAppServerBindingSubscription(
        client,
        sibling.threadId,
        sibling.liveThreadOwnership,
      ),
    ).toBe(true);
    const siblingRoute = getCodexInferenceThread(client, sibling.threadId);
    expect(siblingRoute).toBeDefined();
    await withCodexAppServerSessionDeletion(
      bindingStore,
      { ...context.sessionTarget, assertCurrent: () => {} },
      async (mutation) => {
        mutation.commit();
      },
    );
    expect(getCodexInferenceThread(client, main.threadId)).toBeUndefined();
    expect(getCodexInferenceThread(client, sibling.threadId)).toBe(siblingRoute);
    await patchSessionEntry({
      ...context.sessionTarget,
      update: () => ({
        sessionId: "session-after-delete",
        modelOverride: params.modelId,
        providerOverride: params.provider,
      }),
    });
    const resumedContext = {
      ...context,
      sessionId: "session-after-delete",
      sessionTarget: { ...context.sessionTarget, sessionId: "session-after-delete" },
    };
    const command = createCodexCommand({
      pluginConfig,
      deps: createCodexCommandHost({ bindingStore }),
    });
    const reply = await command.handler(
      createContext("resume " + main.threadId, undefined, resumedContext),
    );
    expect(reply.text).toContain("Attached this OpenClaw session");
    expect(bindingStore.read({ kind: "session", ...resumedContext.sessionTarget })).toMatchObject({
      threadId: main.threadId,
      pendingResumeConfiguration: true,
    });
    const resumed = await startOrResumeThreadWithEmptySkillCatalog({
      ...common,
      params: { ...params, ...resumedContext },
    });
    expect(resumed.threadId).toBe(main.threadId);
    expect(resumed.pendingResumeConfiguration).toBeUndefined();
    expect(getCodexInferenceThread(client, main.threadId)).toBeDefined();
    const siblingNext = await startOrResumeThreadWithEmptySkillCatalog({
      ...common,
      params: siblingParams,
    });
    expect(siblingNext.threadId).toBe(sibling.threadId);
    expect(getCodexInferenceThread(client, sibling.threadId)).toBe(siblingRoute);
    expect(client.getCloseError()).toBeUndefined();
    expect(start).toHaveBeenCalledOnce();
  } finally {
    releaseLeasedSharedCodexAppServerClient(client);
    await client.closeAndWait();
    vi.restoreAllMocks();
  }
});
