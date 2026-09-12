import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerUserHomeDir,
} from "./auth-start-options.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { isJsonObject } from "./protocol.js";
import { runCodexAppServerAttempt } from "./run-attempt.js";
import {
  createCodexTestBindingStore,
  sessionBindingIdentity,
} from "./session-binding.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_ASYNC_QUESTIONS === "1";
const describeLive = LIVE ? describe : describe.skip;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  setManagedCodexPluginRoot(undefined);
  vi.unstubAllEnvs();
});

describeLive("Codex async questions real-binary bridge", () => {
  it("continues work before an answer and consumes a later ordinary reply on the same thread", async () => {
    const runtimeModelId = process.env.OPENCLAW_LIVE_CODEX_MODEL?.trim();
    if (!runtimeModelId) {
      throw new Error("Set OPENCLAW_LIVE_CODEX_MODEL to a model with async question support");
    }
    const root = tempDirs.make("openclaw-codex-async-questions-");
    const workspace = path.join(root, "workspace");
    const agentDir = path.join(root, "agent");
    const nativeHome = resolveCodexAppServerHomeDir(agentDir);
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(nativeHome, { recursive: true, mode: 0o700 });
    // Copy only the existing login into the disposable home, never user config or sessions.
    const authFile = path.join(nativeHome, "auth.json");
    await fs.copyFile(path.join(resolveCodexAppServerUserHomeDir(), "auth.json"), authFile);
    await fs.chmod(authFile, 0o600);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    setManagedCodexPluginRoot(path.resolve(import.meta.dirname, "../.."));

    const pluginConfig = { appServer: { homeScope: "agent" } };
    const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig, env: {} });
    const client = await createIsolatedCodexAppServerClient({
      startOptions: runtime.start,
      agentDir,
      authProfileId: null,
      timeoutMs: 120_000,
    });
    let closeHost: (() => void) | undefined;
    try {
      const completedKinds: string[] = [];
      const questionItemIds: string[] = [];
      const serverRequestMethods: string[] = [];
      client.addRequestHandler((request) => {
        serverRequestMethods.push(request.method);
        return undefined;
      });
      client.addNotificationHandler((notification) => {
        if (notification.method !== "item/completed" || !isJsonObject(notification.params)) {
          return;
        }
        const item = notification.params.item;
        if (!isJsonObject(item) || typeof item.type !== "string") {
          return;
        }
        if (
          item.type === "agentMessage" &&
          item.delivery === "async" &&
          Array.isArray(item.questions) &&
          typeof item.id === "string"
        ) {
          questionItemIds.push(item.id);
          completedKinds.push("asyncQuestion");
        } else {
          completedKinds.push(item.type);
        }
      });

      const questions = [
        { title: "Which output format?", options: ["Markdown", "Plain text"] },
        { title: "Who is the audience?" },
      ];
      const deliveredTexts: string[] = [];
      const modelId = runtimeModelId;
      const sessionTarget = {
        agentId: "async-questions",
        sessionId: "async-questions-session",
        sessionKey: "agent:async-questions:main",
        storePath: path.join(agentDir, "openclaw-agent.sqlite"),
      };
      const params = {
        agentId: sessionTarget.agentId,
        sessionId: sessionTarget.sessionId,
        sessionKey: sessionTarget.sessionKey,
        sessionTarget,
        sessionFile: path.join(root, "session.jsonl"),
        workspaceDir: workspace,
        cwd: workspace,
        agentDir,
        provider: "openai",
        modelId,
        model: {
          id: modelId,
          name: modelId,
          provider: "openai",
          api: "openai-chatgpt-responses",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8_000,
          compat: { supportsTools: false },
        },
        prompt: [
          "This is a synthetic async question integration check. All files belong to this disposable workspace.",
          "First call request_user_input_async exactly once with these exact arguments:",
          JSON.stringify({ questions }),
          "These are optional preferences. Immediately after that tool returns, continue independent work without waiting for an answer.",
          "Use a native shell command to create async-question-marker.txt containing exactly AFTER_ASYNC_QUESTION followed by a newline.",
          "Then end this turn with QUESTION_READY. Do not use request_user_input or ask another question.",
        ].join("\n"),
        runId: "async-questions-first-run",
        contextTokenBudget: 150_000,
        contextWindowInfo: {
          tokens: 150_000,
          referenceTokens: 200_000,
          source: "agentContextTokens",
        },
        thinkLevel: "medium",
        disableTools: false,
        config: { tools: { web: { search: { enabled: false } } } },
        timeoutMs: 180_000,
        trigger: "user",
        oneShotCliRun: true,
        senderIsOwner: true,
        authStorage: {},
        authProfileStore: { version: 1, profiles: {} },
        modelRegistry: {},
        onBlockReply: async (payload: { text?: string }) => {
          if (payload.text) {
            deliveredTexts.push(payload.text);
          }
        },
      } as unknown as EmbeddedRunAttemptParams;
      await upsertSessionEntry({
        ...sessionTarget,
        entry: {
          sessionId: sessionTarget.sessionId,
          sessionFile: params.sessionFile,
          updatedAt: Date.now(),
        },
      });
      const host = await createAgentHarnessHostCapabilitiesForTest({
        attempt: params,
        pluginId: "codex",
      });
      params.hostCapabilities = host.capabilities;
      closeHost = host.close;
      const bindingStore = createCodexTestBindingStore();
      const options = {
        bindingStore,
        pluginConfig,
        clientFactory: async () => client,
      };
      const first = await runCodexAppServerAttempt(params, options);

      expect(first.terminal.kind).toBe("ok");
      expect(questionItemIds).toHaveLength(1);
      expect(completedKinds.indexOf("commandExecution")).toBeGreaterThan(
        completedKinds.indexOf("asyncQuestion"),
      );
      expect(await fs.readFile(path.join(workspace, "async-question-marker.txt"), "utf8")).toBe(
        "AFTER_ASYNC_QUESTION\n",
      );
      expect(
        first.messagesSnapshot.filter(
          (message) => message.role === "assistant" && "openclawAsyncDelivery" in message,
        ),
      ).toEqual([
        expect.objectContaining({
          openclawAsyncDelivery: { itemId: questionItemIds[0], questions },
        }),
      ]);
      expect(deliveredTexts).toHaveLength(1);
      expect(deliveredTexts[0]).toContain("Which output format?");
      expect(deliveredTexts[0]).toContain("Who is the audience?");
      const persisted = await readSessionTranscriptEvents(sessionTarget);
      expect(
        persisted.filter(
          (event) =>
            isJsonObject(event) &&
            isJsonObject(event.message) &&
            isJsonObject(event.message.openclawAsyncDelivery),
        ),
      ).toHaveLength(1);
      expect(serverRequestMethods).not.toContain("item/tool/requestUserInput");
      const firstBinding = bindingStore.read(sessionBindingIdentity(params));
      expect(firstBinding).toBeDefined();
      expect(firstBinding?.model === runtimeModelId).toBe(true);
      const firstThreadId = firstBinding?.threadId;
      expect(firstThreadId).toEqual(expect.any(String));

      closeHost();
      closeHost = undefined;
      const followUp = {
        ...params,
        runId: "async-questions-answer-run",
        prompt: [
          "> Which output format?",
          "",
          "Plain text",
          "",
          "> Who is the audience?",
          "",
          "release reviewers",
          "",
          "Use those answers to create async-question-answer.txt containing the chosen format, a vertical bar, then the audience, followed by a newline.",
          "Do not ask further questions. Then reply ANSWER_USED.",
        ].join("\n"),
      };
      const answerHost = await createAgentHarnessHostCapabilitiesForTest({
        attempt: followUp,
        pluginId: "codex",
      });
      followUp.hostCapabilities = answerHost.capabilities;
      closeHost = answerHost.close;
      const answered = await runCodexAppServerAttempt(followUp, options);

      expect(answered.terminal.kind).toBe("ok");
      expect(bindingStore.read(sessionBindingIdentity(followUp))?.threadId).toBe(firstThreadId);
      expect(await fs.readFile(path.join(workspace, "async-question-answer.txt"), "utf8")).toBe(
        "Plain text|release reviewers\n",
      );
      expect(serverRequestMethods).not.toContain("item/tool/requestUserInput");
    } finally {
      closeHost?.();
      await client.closeAndWait();
    }
  }, 480_000);
});
