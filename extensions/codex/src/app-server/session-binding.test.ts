import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  CODEX_APP_SERVER_BINDING_PLUGIN_ID,
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
  type CodexAppServerAuthProfileLookup,
} from "./session-binding.js";

let tempDir: string;
let previousStateDir: string | undefined;

const nativeAuthLookup: Pick<CodexAppServerAuthProfileLookup, "authProfileStore"> = {
  authProfileStore: {
    version: 1,
    profiles: {
      work: {
        type: "oauth",
        provider: "openai-codex",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    },
  },
};

function writeRawCodexAppServerBinding(key: string, value: unknown): void {
  createPluginStateSyncKeyedStore<unknown>(CODEX_APP_SERVER_BINDING_PLUGIN_ID, {
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  }).register(key, value);
}

function readRawCodexAppServerBinding(key: string): unknown {
  return createPluginStateSyncKeyedStore<unknown>(CODEX_APP_SERVER_BINDING_PLUGIN_ID, {
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  }).lookup(key);
}

async function writeCodexCliAuthFile(codexHome: string): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify({
      tokens: {
        access_token: "cli-access-token",
        refresh_token: "cli-refresh-token",
        account_id: "account-cli",
      },
    })}\n`,
  );
}

describe("codex app-server session binding", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("round-trips the thread binding through SQLite", async () => {
    const sessionId = "session-1";
    await writeCodexAppServerBinding(
      { sessionId },
      {
        threadId: "thread-123",
        cwd: tempDir,
        model: "gpt-5.4-codex",
        modelProvider: "openai",
        dynamicToolsFingerprint: "tools-v1",
      },
    );

    const binding = await readCodexAppServerBinding({ sessionId });

    expect(binding?.schemaVersion).toBe(1);
    expect(binding?.threadId).toBe("thread-123");
    expect(binding?.sessionId).toBe(sessionId);
    expect(binding?.cwd).toBe(tempDir);
    expect(binding?.model).toBe("gpt-5.4-codex");
    expect(binding?.modelProvider).toBe("openai");
    expect(binding?.dynamicToolsFingerprint).toBe("tools-v1");
  });

  it("round-trips plugin app policy context with app ids as record keys", async () => {
    const sessionId = "session";
    const pluginAppPolicyContext = {
      fingerprint: "plugin-policy-1",
      apps: {
        "google-calendar-app": {
          configKey: "google-calendar",
          marketplaceName: "openai-curated" as const,
          pluginName: "google-calendar",
          allowDestructiveActions: true,
          mcpServerNames: ["google-calendar"],
        },
      },
      pluginAppIds: {
        "google-calendar": ["google-calendar-app"],
      },
    };
    await writeCodexAppServerBinding(sessionId, {
      threadId: "thread-123",
      cwd: tempDir,
      pluginAppPolicyContext,
    });

    const binding = await readCodexAppServerBinding(sessionId);

    expect(binding?.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("rejects old plugin app policy entries that duplicate the app id", async () => {
    const sessionId = "session";
    writeRawCodexAppServerBinding(sessionId, {
      schemaVersion: 1,
      threadId: "thread-123",
      sessionId,
      cwd: tempDir,
      pluginAppPolicyContext: {
        fingerprint: "plugin-policy-1",
        apps: {
          "google-calendar-app": {
            appId: "google-calendar-app",
            configKey: "google-calendar",
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
            allowDestructiveActions: true,
            mcpServerNames: ["google-calendar"],
          },
        },
        pluginAppIds: {
          "google-calendar": ["google-calendar-app"],
        },
      },
      createdAt: "2026-05-03T00:00:00.000Z",
      updatedAt: "2026-05-03T00:00:00.000Z",
    });

    const binding = await readCodexAppServerBinding(sessionId);

    expect(binding?.pluginAppPolicyContext).toBeUndefined();
  });

  it("keys new bindings by OpenClaw session id and stores the session key as metadata", async () => {
    const sessionId = "session";
    const sessionKey = "agent:main:codex-thread";
    await writeCodexAppServerBinding(
      { sessionKey, sessionId },
      {
        threadId: "thread-session-key",
        cwd: tempDir,
      },
    );

    await expect(readCodexAppServerBinding({ sessionKey, sessionId })).resolves.toMatchObject({
      threadId: "thread-session-key",
      sessionKey,
      sessionId,
    });
    await expect(readCodexAppServerBinding(sessionId)).resolves.toMatchObject({
      threadId: "thread-session-key",
      sessionKey,
      sessionId,
    });
  });

  it("does not persist public OpenAI as the provider for Codex-native auth bindings", async () => {
    const sessionId = "session";
    await writeCodexAppServerBinding(
      sessionId,
      {
        threadId: "thread-123",
        cwd: tempDir,
        authProfileId: "work",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
      },
      nativeAuthLookup,
    );

    const binding = await readCodexAppServerBinding(sessionId, nativeAuthLookup);

    expect(binding?.threadId).toBe("thread-123");
    expect(binding?.authProfileId).toBe("work");
    expect(binding?.model).toBe("gpt-5.4-mini");
    expect(binding?.modelProvider).toBeUndefined();
  });

  it("normalizes older Codex-native bindings that stored public OpenAI provider", async () => {
    const sessionId = "session";
    writeRawCodexAppServerBinding(sessionId, {
      schemaVersion: 1,
      threadId: "thread-123",
      sessionId,
      cwd: tempDir,
      authProfileId: "work",
      model: "gpt-5.4-mini",
      modelProvider: "openai",
      createdAt: "2026-05-03T00:00:00.000Z",
      updatedAt: "2026-05-03T00:00:00.000Z",
    });

    const binding = await readCodexAppServerBinding(sessionId, nativeAuthLookup);

    expect(binding?.authProfileId).toBe("work");
    expect(binding?.modelProvider).toBeUndefined();
  });

  it("normalizes legacy fast service tier bindings to Codex priority", async () => {
    const sessionId = "session";
    writeRawCodexAppServerBinding(sessionId, {
      schemaVersion: 1,
      threadId: "thread-123",
      sessionId,
      cwd: tempDir,
      serviceTier: "fast",
      createdAt: "2026-05-03T00:00:00.000Z",
      updatedAt: "2026-05-03T00:00:00.000Z",
    });

    const binding = await readCodexAppServerBinding(sessionId);

    expect(binding?.serviceTier).toBe("priority");
  });

  it("does not infer native Codex auth from the profile id prefix", async () => {
    const sessionId = "session";
    await writeCodexAppServerBinding(
      sessionId,
      {
        threadId: "thread-123",
        cwd: tempDir,
        authProfileId: "openai-codex:work",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
      },
      {
        authProfileStore: {
          version: 1,
          profiles: {
            "openai-codex:work": {
              type: "api_key",
              provider: "openai",
              key: "sk-test",
            },
          },
        },
      },
    );

    const binding = await readCodexAppServerBinding(sessionId, {
      authProfileStore: {
        version: 1,
        profiles: {
          "openai-codex:work": {
            type: "api_key",
            provider: "openai",
            key: "sk-test",
          },
        },
      },
    });

    expect(binding?.modelProvider).toBe("openai");
  });

  it("normalizes Codex CLI OAuth bindings even without a local auth profile slot", async () => {
    const sessionId = "session";
    const codexHome = path.join(tempDir, "codex-cli");
    const agentDir = path.join(tempDir, "agent");
    vi.stubEnv("CODEX_HOME", codexHome);
    await writeCodexCliAuthFile(codexHome);

    await writeCodexAppServerBinding(
      sessionId,
      {
        threadId: "thread-123",
        cwd: tempDir,
        authProfileId: "openai-codex:default",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
      },
      { agentDir },
    );

    const raw = readRawCodexAppServerBinding(sessionId) as { modelProvider?: unknown };
    const binding = await readCodexAppServerBinding(sessionId, { agentDir });

    expect(raw.modelProvider).toBeUndefined();
    expect(binding?.authProfileId).toBe("openai-codex:default");
    expect(binding?.modelProvider).toBeUndefined();
  });

  it("clears missing bindings without throwing", async () => {
    const sessionId = "missing";
    await clearCodexAppServerBinding(sessionId);
    await expect(readCodexAppServerBinding(sessionId)).resolves.toBeUndefined();
  });
});
