import { describe, expect, it, vi } from "vitest";
import {
  createCodexRuntimeContextOverrides,
  runCommand,
  useCodexCommandTestState,
  writeTestBinding,
} from "./commands.test-support.js";

const instructions = '  Check  the "read path"\n  and keep `src\\nested` unchanged.  ';
const fullSha = "0123456789aBcDeF0123456789abcdef01234567";

const usage = "Usage: /codex review [--base <branch> | --commit <sha> | <instructions>]";

describe("/codex review arguments", () => {
  let tempDir: string;
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      tempDir = stateDir;
    },
  });

  it.each([
    {
      args: 'review --base "release/<@U123>"',
      target: { type: "baseBranch", branch: "release/<@U123>" },
      description: "of changes against release/&lt;\uff20U123&gt;",
    },
    {
      args: "review --commit aBcDeF0",
      target: { type: "commit", sha: "aBcDeF0" },
      description: "of commit aBcDeF0",
    },
    {
      args: `review --commit ${fullSha}`,
      target: { type: "commit", sha: fullSha },
      description: `of commit ${fullSha}`,
    },
    {
      args: `review ${instructions}`,
      target: { type: "custom", instructions },
      description: "with custom instructions",
    },
  ])(
    "starts the requested $target.type review on the bound thread ($args)",
    async ({ args, target, description }) => {
      const context = await createCodexRuntimeContextOverrides(tempDir);
      await writeTestBinding(
        {
          kind: "session",
          agentId: "main",
          sessionId: "session-1",
          sessionKey: context.sessionKey,
        },
        { threadId: "thread-review", cwd: "/codex/checkout" },
      );
      const codexControlRequest = vi.fn(async () => undefined);

      const result = await runCommand(args, { codexControlRequest }, context);

      expect(codexControlRequest).toHaveBeenCalledExactlyOnceWith(
        {},
        "review/start",
        { threadId: "thread-review", target },
        expect.anything(),
      );
      expect(result.text).toBe(`Started Codex review ${description} for thread thread-review.`);
    },
  );

  it.each(["review --base main", "review --commit abcdef0", "review Check the tests"])(
    "requires owner or admin for %s",
    async (args) => {
      const codexControlRequest = vi.fn();
      const result = await runCommand(
        args,
        { codexControlRequest },
        {
          senderIsOwner: false,
          gatewayClientScopes: ["operator.write"],
        },
      );

      expect(result.text).toBe(
        "Only an owner or operator.admin can control Codex native execution.",
      );
      expect(codexControlRequest).not.toHaveBeenCalled();
    },
  );

  it("blocks a targeted review in a sandboxed session even for the owner", async () => {
    const codexControlRequest = vi.fn();
    const result = await runCommand(
      "review --base main",
      { codexControlRequest },
      {
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
      },
    );

    expect(result.text).toContain(
      "Codex-native /codex review is unavailable because OpenClaw sandboxing is active for this session.",
    );
    expect(codexControlRequest).not.toHaveBeenCalled();
  });

  it.each([
    "--base main --commit abcdef0",
    "--base main extra instructions",
    "extra instructions --commit abcdef0",
    "--unknown value",
    "--base",
    '--base " "',
    '--base " -main"',
    "--commit",
    "--commit abcdef",
    "--commit abcdefg",
    `--commit ${fullSha}0`,
    '"  "',
  ])("shows only usage for invalid review arguments %s", async (args) => {
    const codexControlRequest = vi.fn();
    const getCurrentConversationBinding = vi.fn();
    const result = await runCommand(
      `review ${args}`,
      { codexControlRequest },
      {
        senderIsOwner: false,
        gatewayClientScopes: ["operator.write"],
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        sessionKey: "sandboxed-session",
        getCurrentConversationBinding,
      },
    );

    expect(result.text).toBe(usage);
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(getCurrentConversationBinding).not.toHaveBeenCalled();
  });
});
