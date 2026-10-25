import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, expect, it } from "vitest";
import { createCodexCatalogHomeResolver } from "../session-catalog-homes.js";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import { resolveCodexBindingAppServerConnection } from "./binding-connection.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import type { CodexPluginConfig } from "./config-contracts.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config-runtime.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { isJsonObject } from "./protocol.js";
import { createCodexAppServerBindingStore, sessionBindingIdentity } from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";
import { createCodexTestModel } from "./test-support.js";
import { startOrResumeThread } from "./thread-lifecycle-run.js";
import { forkResponse, codexForkTurn } from "./upstream-session-fork.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "codex-fork-home-");
it("materializes a persisted upstream fork on its secondary home and native model with applied harness configuration", async () => {
  const root = sessionDirs.make();
  const agentDir = path.join(root, "agents", "main", "agent");
  const sourceAgentDir = path.join(root, "agents", "source", "agent");
  const secondaryHome = resolveCodexAppServerHomeDir(sourceAgentDir);
  const env = { HOME: root, CODEX_HOME: path.join(root, "primary-codex-home") };
  const pluginConfig: CodexPluginConfig = {
    supervision: { enabled: true },
    appServer: { approvalsReviewer: "user" },
  };
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: { agentDir }, source: { agentDir: sourceAgentDir } },
    },
    session: { store: path.join(root, "openclaw-agent.sqlite") },
  };
  const retained = codexForkTurn("turn-1", "one");
  const nativeModel = "gpt-5.6-luna";
  const responseFor = (threadId: string, turns = [retained], model = nativeModel) => {
    const response = forkResponse(threadId);
    return {
      ...response,
      cwd: root,
      model,
      thread: {
        ...response.thread,
        cwd: root,
        status: { type: "idle" as const },
        turns,
      },
    };
  };
  const nativeThreads = new Map([["thread-forked", responseFor("thread-forked")]]);
  const sourceBefore = structuredClone(nativeThreads.get("thread-forked"));
  let nextThreadId = 0;
  const createThread = (model: unknown, turns: (typeof retained)[]) => {
    const response = responseFor(
      `thread-secondary-${nextThreadId++}`,
      turns,
      typeof model === "string" ? model : nativeModel,
    );
    nativeThreads.set(response.thread.id, response);
    return response;
  };
  const native = createFakeCodexAppServerClient(async (method, requestParams) => {
    switch (method) {
      case "config/read":
        return { config: {}, origins: {}, layers: [] };
      case "configRequirements/read":
        return { requirements: null };
      case "skills/list":
        return { data: [] };
    }
    assert(isJsonObject(requestParams));
    if (method === "thread/start") {
      return createThread(requestParams.model, []);
    }
    const { threadId } = requestParams;
    assert(typeof threadId === "string");
    const source = nativeThreads.get(threadId);
    assert(source);
    switch (method) {
      case "thread/read":
        return source;
      case "thread/fork":
        expect(requestParams.lastTurnId).toBe("turn-1");
        return createThread(requestParams.model, [retained]);
      case "thread/unsubscribe":
        return { status: "unsubscribed" };
      case "thread/inject_items":
        assert(Array.isArray(requestParams.items) && requestParams.items.length > 0);
        // Injection does not manufacture native TurnStarted boundaries.
        return {};
      default:
        throw new Error(`Unexpected Codex request: ${method}`);
    }
  });
  const ordinary = createFakeCodexAppServerClient(() => {
    throw new Error("Fork continuation must use the secondary home");
  });
  try {
    await Promise.all(
      [agentDir, secondaryHome, env.CODEX_HOME].map((dir) => fs.mkdir(dir, { recursive: true })),
    );
    const sourceHome = (
      await createCodexCatalogHomeResolver({
        resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
        config,
        getRuntimeConfig: () => config,
        getPluginConfig: () => pluginConfig,
        env,
      }).forAgent("main")
    ).find((home) => home.appServer.start.env?.CODEX_HOME === secondaryHome);
    expect(sourceHome).toBeDefined();
    const fingerprint = buildCodexAppServerConnectionFingerprint(sourceHome!.appServer, agentDir);
    // Fork creation and its persisted binding are covered by upstream-fork-import.test.ts.
    const session = {
      agentId: "main",
      sessionId: "forked-session",
      sessionKey: "agent:main:dashboard:forked",
    };
    await upsertSessionEntry({
      ...session,
      storePath: config.session!.store!,
      entry: { sessionId: session.sessionId, updatedAt: Date.now() },
    });
    const bindingStore = createCodexAppServerBindingStore(createCodexTestBindingStateStore());
    await bindingStore.mutate(sessionBindingIdentity(session), {
      kind: "set",
      binding: {
        threadId: "thread-forked",
        cwd: root,
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-forked",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        pendingSupervisionBranch: {
          sourceThreadId: "thread-forked",
          connectionFingerprint: fingerprint,
          lastTurnId: "turn-1",
        },
      },
    });
    const attempt = {
      ...session,
      agentDir,
      config,
      workspaceDir: root,
      runId: "fork-continuation",
      prompt: "edited request",
      provider: "codex",
      modelId: "gpt-5.5",
      model: { ...createCodexTestModel("codex"), id: "gpt-5.5", name: "gpt-5.5" },
      hostCapabilities: createCodexTestHostCapabilities(),
      authProfileId: "openai:ordinary",
      authProfileStore: { version: 1, profiles: {} },
      timeoutMs: 5_000,
    } as EmbeddedRunAttemptParams;
    const identity = sessionBindingIdentity(attempt);
    const dynamicTools = [
      {
        type: "function" as const,
        name: "message",
        description: "Send a message",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const developerInstructions = "Follow the child agent's current instructions.";
    const connection = await resolveCodexBindingAppServerConnection({
      binding: bindingStore.read(identity),
      pluginConfig,
      config,
      agentDir,
      env,
      authProfileId: attempt.authProfileId,
      requirementsToml: null,
    });
    const selectedFingerprint = buildCodexAppServerConnectionFingerprint(
      connection.appServer,
      agentDir,
    );
    const selected = selectedFingerprint === fingerprint ? native : ordinary;
    const binding = await startOrResumeThread({
      bindingStore,
      client: selected.client,
      params: {
        ...attempt,
        authProfileId: connection.usesSupervisionConnection ? undefined : attempt.authProfileId,
      },
      cwd: root,
      appServer: connection.appServer,
      dynamicTools,
      developerInstructions,
      userMcpServersEnabled: false,
      hostSystemAgentActive: false,
    });
    expect(connection).toMatchObject({
      appServer: { start: { env: { CODEX_HOME: secondaryHome } } },
      clientAuthProfileId: null,
    });
    expect(ordinary.request).not.toHaveBeenCalled();
    expect(binding).toMatchObject({
      model: nativeModel,
      modelProvider: "openai",
      preserveNativeModel: true,
    });
    const expectNativeRequest = (method: string, request: unknown) =>
      expect(native.request).toHaveBeenCalledWith(method, request, expect.anything());
    expectNativeRequest("thread/unsubscribe", { threadId: "thread-secondary-0" });
    // Native unsubscribe detaches the client; idle retention still owns the thread.
    expect(nativeThreads.has("thread-secondary-0")).toBe(true);
    // Configuration must reach thread/start; persisted fingerprints alone cannot install tools.
    expectNativeRequest(
      "thread/start",
      expect.objectContaining({
        model: nativeModel,
        modelProvider: "openai",
        dynamicTools,
        developerInstructions,
      }),
    );
    expectNativeRequest("thread/inject_items", {
      threadId: binding.threadId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "one" }] }],
    });

    expect(nativeThreads.get("thread-forked")).toEqual(sourceBefore);
  } finally {
    native.close();
    ordinary.close();
  }
});
