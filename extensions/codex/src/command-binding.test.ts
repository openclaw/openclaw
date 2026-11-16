import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import { runCommand, useCodexCommandTestState, writeTestBinding } from "./commands.test-support.js";

const conversationIdentity = { kind: "conversation", bindingId: "binding-data-1" } as const;

let tempDir: string;

function publicConversationBinding(data?: Record<string, unknown>) {
  return {
    bindingId: "binding-1",
    pluginId: "codex",
    pluginRoot: "/plugin",
    channel: "test",
    accountId: "default",
    conversationId: "conversation",
    boundAt: 1,
    ...(data ? { data } : {}),
  };
}

function nativeConversation(workspaceDir = "/repo", fields: Record<string, unknown> = {}) {
  return publicConversationBinding({
    kind: "codex-app-server-session",
    version: 2,
    bindingId: conversationIdentity.bindingId,
    workspaceDir,
    ...fields,
  });
}

function seedSession(
  storePath: string,
  sessionKey: string,
  entry: Partial<Parameters<typeof upsertSessionEntry>[0]["entry"]> = {},
  agentId?: string,
) {
  return upsertSessionEntry({
    storePath,
    sessionKey,
    ...(agentId ? { agentId } : {}),
    entry: { sessionId: "session-1", updatedAt: Date.now(), ...entry },
  });
}

function explicitStoreContext(sessionKey: string, sessionId = "session-1") {
  const storePath = path.join(tempDir, "explicit", "sessions.json");
  const configuredStorePath = path.join(tempDir, "configured", "sessions.json");
  return {
    storePath,
    configuredStorePath,
    context: {
      sessionKey,
      sessionId,
      config: { session: { store: configuredStorePath } },
      sessionTarget: { agentId: "main", sessionId, sessionKey, storePath },
    },
  };
}

describe("Codex conversation binding status", () => {
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      tempDir = stateDir;
    },
  });

  it("inspects an existing managed-session binding without starting a client", async () => {
    const sessionKey = "agent:main:managed-binding";
    const { storePath, context } = explicitStoreContext(sessionKey);
    await seedSession(storePath, sessionKey);
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1", sessionKey },
      { threadId: "managed-thread", cwd: "/managed-workspace", clientId: "absent-client" },
    );
    const rpc = vi.fn(async () => {
      throw new Error("inspection must not start a client");
    });
    const result = await runCommand("binding", { codexControlRequest: rpc }, context);
    expect(result.text).toContain("- Thread: managed-thread");
    expect(result.text).toContain("- Workspace: /managed-workspace");
    expect(result.text).toContain("- Retained native commands: none");
    expect(result.text).toContain("- Binding: managed session");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "renders and escapes binding fields from their owners (active: %s)",
    async (active) => {
      const sessionKey = "agent:main:binding-preferences";
      const { storePath, configuredStorePath, context } = explicitStoreContext(sessionKey);
      if (active) {
        await seedSession(storePath, sessionKey, { permissionMode: "full" });
        await seedSession(configuredStorePath, sessionKey, { permissionMode: "guarded" });
      }
      const threadId = "thread-123 <@U123>";
      await writeTestBinding(conversationIdentity, {
        threadId,
        cwd: "/repo",
        model: "gpt [trusted](https://evil)",
        ...(active
          ? {
              serviceTier: "fast",
              approvalPolicy: "never" as const,
              sandbox: "danger-full-access" as const,
            }
          : {}),
      });

      const result = await runCommand(
        "binding",
        {
          readCodexConversationActiveTurn: vi.fn(() =>
            active
              ? {
                  identity: conversationIdentity,
                  client: { request: vi.fn() } as never,
                  requestTimeoutMs: 60_000,
                  threadId,
                  turnId: "turn-1",
                  interrupt: vi.fn(),
                  steer: vi.fn(),
                }
              : undefined,
          ),
        },
        {
          ...(active ? context : {}),
          getCurrentConversationBinding: async () => nativeConversation("/repo <@U123>"),
        },
      );
      expect(result).toEqual({
        text: [
          "Codex conversation binding:",
          "- Thread: thread-123 &lt;\uff20U123&gt;",
          "- Workspace: /repo &lt;\uff20U123&gt;",
          "- Model: gpt \uff3btrusted\uff3d\uff08https://evil\uff09",
          `- Fast: ${active ? "on" : "off"}`,
          `- Permissions: ${active ? "full access" : "default"}`,
          `- Active run: ${active ? "turn-1" : "none"}`,
          "- Retained native commands: none",
          "- Binding: binding-data-1",
        ].join("\n"),
      });
    },
  );
});
