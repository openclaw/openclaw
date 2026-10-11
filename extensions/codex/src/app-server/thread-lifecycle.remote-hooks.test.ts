import path from "node:path";
import { buildNativeHookRelayCommandPlan } from "openclaw/plugin-sdk/native-hook-relay-runtime";
import { describe, expect, it } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import { createCodexNativeHookRemoteCredential } from "./native-hook-relay-remote.js";
import { buildCodexNativeHookRelayConfig } from "./native-hook-relay.js";
import {
  createParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  createAppServerOptions,
  startOrResumeAttemptThreadWithoutSkills,
} from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks();

describe("Codex remote native hook credential lifecycle", () => {
  it.each([false, true])(
    "refreshes remote hook credentials across two warm turns (incognito: %s)",
    async (incognito) => {
      const workspaceDir = path.join(tempDir, "remote-hook-workspace");
      const params = createParams(path.join(tempDir, "remote-hook-session.jsonl"), workspaceDir);
      params.disableTools = false;
      params.config = undefined;
      if (incognito) {
        params.sessionKey = "agent:main:dashboard:incognito-remote-hooks";
      }
      const files = new Map<string, string>();
      const fake = createFakeCodexAppServerClient(async (method, value) => {
        if (method === "config/read") {
          return { layers: [], config: { mcp_servers: {} } };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start" || method === "thread/resume") {
          return threadStartResult("remote-hooks-thread");
        }
        if (method === "thread/unsubscribe") {
          return { status: "unsubscribed" };
        }
        if (method === "fs/writeFile") {
          const write = value as { path: string; dataBase64: string };
          files.set(write.path, Buffer.from(write.dataBase64, "base64").toString());
          return {};
        }
        if (method === "fs/remove") {
          files.delete((value as { path: string }).path);
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const client = fake.client;
      ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
      let projection: ReturnType<typeof createCodexNativeHookRemoteCredential> | undefined;
      let registration = 0;
      const common = {
        client,
        params,
        cwd: workspaceDir,
        signal: new AbortController().signal,
        dynamicTools: [],
        appServer: { ...createAppServerOptions(), connectionClass: "local-loopback" as const },
        userMcpServersEnabled: false,
        buildFinalConfigPatch: async () => {
          await projection?.dispose();
          const relayId = "remote-hooks-relay";
          const generation = "stable-generation";
          const token = `synthetic-token-${++registration}`;
          projection = createCodexNativeHookRemoteCredential({
            config: {
              url: "https://gateway.example/node/__openclaw__/native-hook",
              credentialDirectory: "/private/hooks",
            },
            client,
            relay: { relayId, generation, enableRemoteCallback: () => ({ token }) },
            timeoutMs: 1_000,
            assertCurrent: () => {},
          });
          await projection.prepare();
          return {
            configPatch: buildCodexNativeHookRelayConfig({
              relay: buildNativeHookRelayCommandPlan({
                provider: "codex",
                relayId,
                generation,
                executionAdmissionToolNames: ["exec"],
              }),
              events: ["pre_tool_use"],
              remoteCredentialPath: projection.path,
            }),
            nativeHookRelayGeneration: generation,
          };
        },
      };
      try {
        const first = await startOrResumeAttemptThreadWithoutSkills(common);
        const installedPath = projection!.path;
        expect(
          JSON.stringify(
            fake.request.mock.calls.find(([method]) => method === "thread/start")?.[1],
          ),
        ).toContain(installedPath);
        await expect(
          retainCodexAppServerLiveThread(
            client,
            first.threadId,
            undefined,
            first.liveThreadConfigFingerprint,
            null,
            first.liveThreadEphemeralPolicy,
          ),
        ).resolves.toBe(true);
        const second = await startOrResumeAttemptThreadWithoutSkills(common);
        expect(second.threadId).toBe(first.threadId);
        expect(
          fake.request.mock.calls.filter(([method]) => method === "thread/resume"),
        ).toHaveLength(0);
        expect(projection!.path).toBe(installedPath);
        expect(JSON.parse(files.get(installedPath)!)).toMatchObject({ token: "synthetic-token-2" });
      } finally {
        await projection?.dispose();
      }
    },
  );
});
