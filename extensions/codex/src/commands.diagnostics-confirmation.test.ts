import path from "node:path";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import type { CodexAppServerThreadBinding } from "./app-server/session-binding.js";
import { testCodexAppServerBindingStore as bindingStore } from "./app-server/session-binding.test-helpers.js";
import { handleCodexCommand } from "./command-dispatch.js";
import {
  createContext,
  createDeps,
  expectedDiagnosticsTargetBlock,
  readDiagnosticsConfirmationToken,
  supervisedTestBinding,
  writeTestBinding,
  useCodexCommandTestState,
} from "./commands.test-support.js";

describe("Codex diagnostics confirmation", () => {
  let tempDir: string;
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      tempDir = stateDir;
    },
  });

  async function fixture(
    binding: CodexAppServerThreadBinding = { threadId: "thread-diagnostics", cwd: "/repo" },
    context: Partial<PluginCommandContext> = {},
    pluginConfig?: unknown,
  ) {
    const identity = {
      kind: "session" as const,
      agentId: context.agentId ?? "main",
      sessionId: context.sessionId ?? "session-1",
      sessionKey: context.sessionKey,
    };
    await writeTestBinding(identity, binding);
    const upload = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: binding.threadId },
    }));
    const deps = createDeps({ safeCodexControlRequest: upload });
    const run = (args: string, overrides: Partial<PluginCommandContext> = {}) =>
      handleCodexCommand(createContext(args, undefined, { ...context, ...overrides }), {
        deps,
        pluginConfig,
      });
    return { identity, upload, deps, run };
  }

  it("preserves an accepted upload and blocks the next target after owner revocation", async () => {
    let ownerCurrent = true;
    const f = await fixture(
      { threadId: "thread-session-1", cwd: "/repo" },
      {
        diagnosticsUploadApproved: true,
        diagnosticsSessions: [{ sessionId: "session-2", channel: "test" }],
        assertOwnerCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
      },
    );
    await writeTestBinding(
      { ...f.identity, sessionId: "session-2" },
      { threadId: "thread-session-2", cwd: "/repo" },
    );
    f.upload.mockImplementation(async () => {
      ownerCurrent = false;
      return { ok: true, value: { threadId: "thread-session-1" } };
    });
    const result = await f.run("diagnostics");
    expect(f.upload).toHaveBeenCalledOnce();
    expect(result.text).toContain("Codex diagnostics sent to OpenAI servers:");
    expect(result.text).toContain("Could not send Codex diagnostics:");
    expect(result.text).toContain("Command owner was revoked");
  });

  it("rejects diagnostics confirmation when the thread auth scope changes", async () => {
    const f = await fixture({
      threadId: "thread-auth-change",
      cwd: "/repo",
      authProfileId: "openai:first",
    });
    const token = readDiagnosticsConfirmationToken(await f.run("diagnostics"));
    await bindingStore.mutate(f.identity, {
      kind: "patch",
      threadId: "thread-auth-change",
      patch: { authProfileId: "openai:second" },
    });
    await expect(f.run(`diagnostics confirm ${token}`)).resolves.toEqual({
      text: "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.",
    });
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("sends supervised diagnostics through the native user-home connection", async () => {
    const pluginConfig = { supervision: { enabled: true } };
    const f = await fixture(
      supervisedTestBinding("thread-supervised-diagnostics"),
      {},
      pluginConfig,
    );
    const token = readDiagnosticsConfirmationToken(await f.run("diagnostics"));
    await f.run(`diagnostics confirm ${token}`);
    expect(f.upload).toHaveBeenCalledWith(
      pluginConfig,
      CODEX_CONTROL_METHODS.feedback,
      expect.objectContaining({ threadId: "thread-supervised-diagnostics" }),
      expect.objectContaining({
        authProfileId: null,
        startOptions: expect.objectContaining({ homeScope: "user" }),
      }),
    );
  });

  it.each([
    {
      change: "private connection scope",
      replacement: { threadId: "thread-scope-change", cwd: "/repo" },
    },
    {
      change: "supervised connection",
      replacement: {
        ...supervisedTestBinding("thread-scope-change"),
        appServerRuntimeFingerprint: "changed-connection",
      },
    },
  ])("rejects diagnostics confirmation when the $change changes", async ({ replacement }) => {
    let binding: CodexAppServerThreadBinding = supervisedTestBinding("thread-scope-change");
    const f = await fixture(binding, {}, { supervision: { enabled: true } });
    f.deps.bindingStore = { ...bindingStore, read: () => binding };
    const token = readDiagnosticsConfirmationToken(await f.run("diagnostics"));
    binding = replacement;
    await expect(f.run(`diagnostics confirm ${token}`)).resolves.toEqual({
      text: "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.",
    });
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("rejects malformed diagnostics confirmation commands without consuming the token", async () => {
    const f = await fixture();
    const token = readDiagnosticsConfirmationToken(await f.run("diagnostics"));
    for (const action of ["confirm", "cancel"]) {
      await expect(f.run(`diagnostics ${action} ${token} extra`)).resolves.toEqual({
        text: [
          "Usage: /codex diagnostics [note]",
          "Usage: /codex diagnostics confirm <token>",
          "Usage: /codex diagnostics cancel <token>",
        ].join("\n"),
      });
    }
    expect(f.upload).not.toHaveBeenCalled();
    expect((await f.run(`diagnostics confirm ${token}`)).text).toContain(
      "Codex diagnostics sent to OpenAI servers:",
    );
    expect(f.upload).toHaveBeenCalledOnce();
  });

  it("previews exec-approved diagnostics upload without exposing Codex ids", async () => {
    const f = await fixture(
      { threadId: "thread-preview", cwd: "/repo" },
      {
        diagnosticsPreviewOnly: true,
        sessionId: "session-preview",
        sessionKey: "agent:main:telegram:preview",
      },
    );
    const result = await f.run("diagnostics flaky tool call");
    expect(result.text).toBe(
      [
        "Codex runtime thread detected.",
        "Approving diagnostics will also send this thread's feedback bundle to OpenAI servers.",
        "The completed diagnostics reply will list the OpenClaw session ids and Codex thread ids that were sent.",
        "Note: flaky tool call",
        "Included: Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    );
    for (const hidden of [
      "thread-preview",
      "session-preview",
      "agent:main:telegram:preview",
      "To send:",
    ]) {
      expect(result.text).not.toContain(hidden);
    }
    expect(result.interactive).toBeUndefined();
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("uploads all Codex diagnostics sessions and reports their channel/thread breakdown", async () => {
    const targets = [
      {
        agentId: "first",
        sessionKey: "agent:first:whatsapp:one",
        sessionId: "session-one",
        channel: "whatsapp",
        threadId: "thread-111",
      },
      {
        agentId: "second",
        sessionKey: "agent:second:discord:two",
        sessionId: "session-two",
        channel: "discord",
        threadId: "thread-222",
      },
    ];
    const f = await fixture(
      { threadId: "thread-111", cwd: "/repo", authProfileId: "openai:first" },
      {
        agentId: "first",
        sessionId: "session-one",
        sessionKey: "agent:first:whatsapp:one",
        channel: "whatsapp",
        diagnosticsSessions: targets,
      },
    );
    await writeTestBinding(
      {
        kind: "session",
        agentId: "second",
        sessionId: "session-two",
        sessionKey: "agent:second:discord:two",
      },
      { threadId: "thread-222", cwd: "/repo", authProfileId: "openai:second" },
    );
    const upload = vi.fn(async (_config: unknown, _method: string, params: unknown) => {
      if (
        !params ||
        typeof params !== "object" ||
        !("threadId" in params) ||
        typeof params.threadId !== "string"
      ) {
        throw new Error("Expected a diagnostics thread id");
      }
      return { ok: true as const, value: { threadId: params.threadId } };
    });
    f.deps.safeCodexControlRequest = upload;
    const request = await f.run("diagnostics multi-session repro");
    const token = readDiagnosticsConfirmationToken(request);
    expect(request.text).toContain("Codex runtime threads detected.");
    for (const target of targets) {
      for (const [label, value] of [
        ["OpenClaw session key", target.sessionKey],
        ["OpenClaw session id", target.sessionId],
        ["Codex thread id", target.threadId],
      ]) {
        expect(request.text).toContain(`${label}: \`${value}\``);
      }
    }
    expect(request.interactive).toMatchObject({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              action: { type: "command", command: `/codex diagnostics confirm ${token}` },
              value: `/codex diagnostics confirm ${token}`,
              style: "danger",
            },
            {
              action: { type: "command", command: `/codex diagnostics cancel ${token}` },
              value: `/codex diagnostics cancel ${token}`,
              style: "secondary",
            },
          ],
        },
      ],
    });
    expect(upload).not.toHaveBeenCalled();
    await expect(f.run(`diagnostics confirm ${token}`)).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({ index: 1, ...targets[0]! }),
        "",
        ...expectedDiagnosticsTargetBlock({ index: 2, ...targets[1]! }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(upload).toHaveBeenCalledTimes(2);
    for (const target of targets) {
      expect(upload).toHaveBeenCalledWith(
        undefined,
        CODEX_CONTROL_METHODS.feedback,
        expect.objectContaining({ threadId: target.threadId, includeLogs: true }),
        {
          config: {},
          agentDir: path.join(tempDir, "agents", target.agentId, "agent"),
          assertCurrent: expect.any(Function),
          authProfileId: `openai:${target.agentId}`,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
        },
      );
    }
  });
});
