import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import type { CodexAppServerThreadBinding } from "./app-server/session-binding.js";
import { testCodexAppServerBindingStore } from "./app-server/session-binding.test-helpers.js";
import { handleCodexCommand } from "./command-dispatch.js";
import {
  createContext,
  createDeps,
  expectedDiagnosticsTargetBlock,
  expectResultTextContains,
  mockArg,
  readDiagnosticsConfirmationToken,
  requestParams,
  supervisedTestBinding,
  writeTestBinding,
  useCodexCommandTestState,
} from "./commands.test-support.js";

describe("codex command", () => {
  let tempDir: string;
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      tempDir = stateDir;
    },
  });

  it("preserves an accepted upload and blocks the next target after owner revocation", async () => {
    for (const sessionId of ["session-1", "session-2"]) {
      await writeTestBinding(
        { kind: "session", agentId: "main", sessionId },
        { threadId: `thread-${sessionId}`, cwd: "/repo" },
      );
    }
    let ownerCurrent = true;
    const safeCodexControlRequest = vi.fn(async () => {
      ownerCurrent = false;
      return { ok: true as const, value: { threadId: "thread-session-1" } };
    });
    const result = await handleCodexCommand(
      createContext("diagnostics", undefined, {
        diagnosticsUploadApproved: true,
        diagnosticsSessions: [{ sessionId: "session-2", channel: "test" }],
        assertOwnerCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
      }),
      { deps: createDeps({ safeCodexControlRequest }) },
    );
    expect(safeCodexControlRequest).toHaveBeenCalledOnce();
    expect(result.text).toContain("Codex diagnostics sent to OpenAI servers:");
    expect(result.text).toContain("Could not send Codex diagnostics:");
    expect(result.text).toContain("Command owner was revoked");
  });

  it("asks before sending diagnostics feedback for the attached Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      },
      { threadId: "thread-123", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-123" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(
      createContext("diagnostics tool loop repro", sessionFile, {
        senderId: "user-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      }),
      { deps },
    );

    const token = readDiagnosticsConfirmationToken(request);
    expect(request.text).toBe(
      [
        "Codex runtime thread detected.",
        "Codex diagnostics can send this thread's feedback bundle to OpenAI servers.",
        "Codex sessions:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionKey: "agent:main:session-1",
          sessionId: "session-1",
          threadId: "thread-123",
        }),
        "Note: tool loop repro",
        "Included: Codex logs and spawned Codex subthreads when available.",
        `To send: /codex diagnostics confirm ${token}`,
        `To cancel: /codex diagnostics cancel ${token}`,
        "This request expires in 5 minutes.",
      ].join("\n"),
    );
    expect(request.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Send diagnostics",
              action: { type: "command", command: `/codex diagnostics confirm ${token}` },
              value: `/codex diagnostics confirm ${token}`,
              style: "danger",
            },
            {
              label: "Cancel",
              action: { type: "command", command: `/codex diagnostics cancel ${token}` },
              value: `/codex diagnostics cancel ${token}`,
              style: "secondary",
            },
          ],
        },
      ],
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, sessionFile, {
          senderId: "user-1",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionKey: "agent:main:session-1",
          sessionId: "session-1",
          threadId: "thread-123",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.feedback,
      {
        classification: "bug",
        reason: "tool loop repro",
        threadId: "thread-123",
        includeLogs: true,
        tags: {
          source: "openclaw-diagnostics",
          channel: "test",
        },
      },
      {
        config: {},
        agentDir: path.join(tempDir, "agents", "main", "agent"),
        assertCurrent: expect.any(Function),
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      },
    );
  });

  it("rejects diagnostics confirmation when the thread auth scope changes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    await writeTestBinding(identity, {
      threadId: "thread-auth-change",
      cwd: "/repo",
      authProfileId: "openai:first",
    });
    const safeCodexControlRequest = vi.fn();
    const deps = createDeps({ safeCodexControlRequest });
    const request = await handleCodexCommand(createContext("diagnostics", sessionFile), { deps });
    const token = readDiagnosticsConfirmationToken(request);
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "patch",
      threadId: "thread-auth-change",
      patch: { authProfileId: "openai:second" },
    });

    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`, sessionFile), { deps }),
    ).resolves.toEqual({
      text: "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("sends supervised diagnostics through the native user-home connection", async () => {
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    await writeTestBinding(identity, supervisedTestBinding("thread-supervised-diagnostics"));
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-supervised-diagnostics" },
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const pluginConfig = { supervision: { enabled: true } };
    const request = await handleCodexCommand(createContext("diagnostics"), {
      deps,
      pluginConfig,
    });
    const token = readDiagnosticsConfirmationToken(request);

    await handleCodexCommand(createContext(`diagnostics confirm ${token}`), {
      deps,
      pluginConfig,
    });

    expect(safeCodexControlRequest).toHaveBeenCalledWith(
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
    const safeCodexControlRequest = vi.fn();
    const deps = createDeps({
      bindingStore: { ...testCodexAppServerBindingStore, read: () => binding },
      safeCodexControlRequest,
    });
    const pluginConfig = { supervision: { enabled: true } };
    const request = await handleCodexCommand(createContext("diagnostics"), { deps, pluginConfig });
    const token = readDiagnosticsConfirmationToken(request);
    binding = replacement;

    await expect(
      handleCodexCommand(createContext(`diagnostics confirm ${token}`), { deps, pluginConfig }),
    ).resolves.toEqual({
      text: "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("rejects malformed diagnostics confirmation commands without consuming the token", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-confirm-args", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-confirm-args" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await handleCodexCommand(createContext("diagnostics", sessionFile), { deps });
    const token = readDiagnosticsConfirmationToken(request);

    for (const action of ["confirm", "cancel"]) {
      await expect(
        handleCodexCommand(createContext(`diagnostics ${action} ${token} extra`, sessionFile), {
          deps,
        }),
      ).resolves.toEqual({
        text: [
          "Usage: /codex diagnostics [note]",
          "Usage: /codex diagnostics confirm <token>",
          "Usage: /codex diagnostics cancel <token>",
        ].join("\n"),
      });
    }
    expect(safeCodexControlRequest).not.toHaveBeenCalled();

    const confirmResult = await handleCodexCommand(
      createContext(`diagnostics confirm ${token}`, sessionFile),
      { deps },
    );
    expectResultTextContains(confirmResult, "Codex diagnostics sent to OpenAI servers:");
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("previews exec-approved diagnostics upload without exposing Codex ids", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-preview",
        sessionKey: "agent:main:telegram:preview",
      },
      { threadId: "thread-preview", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-preview" },
    }));

    const result = await handleCodexCommand(
      createContext("diagnostics flaky tool call", sessionFile, {
        diagnosticsPreviewOnly: true,
        senderId: "user-1",
        sessionId: "session-preview",
        sessionKey: "agent:main:telegram:preview",
      }),
      { deps: createDeps({ safeCodexControlRequest }) },
    );

    expect(result.text).toBe(
      [
        "Codex runtime thread detected.",
        "Approving diagnostics will also send this thread's feedback bundle to OpenAI servers.",
        "The completed diagnostics reply will list the OpenClaw session ids and Codex thread ids that were sent.",
        "Note: flaky tool call",
        "Included: Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    );
    expect(result.text).not.toContain("thread-preview");
    expect(result.text).not.toContain("session-preview");
    expect(result.text).not.toContain("agent:main:telegram:preview");
    expect(result.text).not.toContain("To send:");
    expect(result.interactive).toBeUndefined();
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("uploads all Codex diagnostics sessions and reports their channel/thread breakdown", async () => {
    await writeTestBinding(
      {
        kind: "session",
        agentId: "first",
        sessionId: "session-one",
        sessionKey: "agent:first:whatsapp:one",
      },
      { threadId: "thread-111", cwd: "/repo", authProfileId: "openai:first" },
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
    const safeCodexControlRequest = vi.fn(async (configForTest, _method, requestParamsLocal) => ({
      ok: true as const,
      value: {
        threadId:
          requestParamsLocal &&
          typeof requestParamsLocal === "object" &&
          "threadId" in requestParamsLocal
            ? requestParamsLocal.threadId
            : undefined,
      },
    }));
    const deps = createDeps({ safeCodexControlRequest });
    const diagnosticsSessions = [
      {
        sessionKey: "agent:first:whatsapp:one",
        sessionId: "session-one",
        channel: "whatsapp",
      },
      {
        sessionKey: "agent:second:discord:two",
        sessionId: "session-two",
        channel: "discord",
      },
    ];

    const request = await handleCodexCommand(
      createContext("diagnostics multi-session repro", undefined, {
        senderId: "user-1",
        channel: "whatsapp",
        agentId: "first",
        sessionKey: "agent:first:whatsapp:one",
        sessionId: "session-one",
        diagnosticsSessions,
      }),
      { deps },
    );
    const token = readDiagnosticsConfirmationToken(request);
    expect(request.text).toContain("Codex runtime threads detected.");
    expect(request.text).toContain("OpenClaw session key: `agent:first:whatsapp:one`");
    expect(request.text).toContain("OpenClaw session id: `session-one`");
    expect(request.text).toContain("Codex thread id: `thread-111`");
    expect(request.text).toContain("OpenClaw session key: `agent:second:discord:two`");
    expect(request.text).toContain("OpenClaw session id: `session-two`");
    expect(request.text).toContain("Codex thread id: `thread-222`");
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
    await expect(
      handleCodexCommand(
        createContext(`diagnostics confirm ${token}`, undefined, {
          senderId: "user-1",
          channel: "whatsapp",
          agentId: "first",
          sessionKey: "agent:first:whatsapp:one",
          sessionId: "session-one",
          diagnosticsSessions,
        }),
        { deps },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          index: 1,
          channel: "whatsapp",
          sessionKey: "agent:first:whatsapp:one",
          sessionId: "session-one",
          threadId: "thread-111",
        }),
        "",
        ...expectedDiagnosticsTargetBlock({
          index: 2,
          channel: "discord",
          sessionKey: "agent:second:discord:two",
          sessionId: "session-two",
          threadId: "thread-222",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
    for (const [index, agentId, sessionId, sessionKey, threadId] of [
      [0, "first", "session-one", "agent:first:whatsapp:one", "thread-111"],
      [1, "second", "session-two", "agent:second:discord:two", "thread-222"],
    ] as const) {
      expect(mockArg(safeCodexControlRequest, index, 0)).toBeUndefined();
      expect(mockArg(safeCodexControlRequest, index, 1)).toBe(CODEX_CONTROL_METHODS.feedback);
      const feedback = requestParams(safeCodexControlRequest, index);
      expect(feedback.threadId).toBe(threadId);
      expect(feedback.includeLogs).toBe(true);
      expect(mockArg(safeCodexControlRequest, index, 3)).toEqual({
        config: {},
        agentDir: path.join(tempDir, "agents", agentId, "agent"),
        assertCurrent: expect.any(Function),
        authProfileId: `openai:${agentId}`,
        sessionId,
        sessionKey,
      });
    }
  });
});
