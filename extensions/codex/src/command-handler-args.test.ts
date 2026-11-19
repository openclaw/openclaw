import { describe, expect, it, vi } from "vitest";
import {
  createCodexRuntimeContextOverrides,
  runCommand,
  useCodexCommandTestState,
  writeTestBinding,
} from "./commands.test-support.js";

const fullSha = "0123456789aBcDeF0123456789abcdef01234567";

const usage = "Usage: /codex review [--base <branch> | --commit <sha> | <instructions>]";

describe("/codex review arguments", () => {
  let tempDir: string;
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      tempDir = stateDir;
    },
  });

  async function bindReviewThread() {
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
    return context;
  }

  it.each([
    {
      args: 'review --base "release/<@U123>"',
      target: { type: "baseBranch", branch: "release/<@U123>" },
      description: "of changes against release/&lt;\uff20U123&gt;",
    },
    {
      args: `review --base "rachel's-fix"`,
      target: { type: "baseBranch", branch: "rachel's-fix" },
      description: "of changes against rachel's-fix",
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
      asAdmin: true,
    },
  ])(
    "starts the requested $target.type review on the bound thread ($args)",
    async ({ args, target, description, asAdmin }) => {
      const context = await bindReviewThread();
      const codexControlRequest = vi.fn(async () => undefined);

      const result = await runCommand(
        args,
        { codexControlRequest },
        asAdmin
          ? { ...context, senderIsOwner: false, gatewayClientScopes: ["operator.admin"] }
          : context,
      );

      expect(codexControlRequest).toHaveBeenCalledExactlyOnceWith(
        {},
        "review/start",
        { threadId: "thread-review", target },
        expect.anything(),
      );
      expect(result.text).toBe(`Started Codex review ${description} for thread thread-review.`);
    },
  );

  it.each([
    'Check  the "read path"\n  and keep `src\\nested` unchanged.',
    "check the --force handling",
    'check the "--force" handling',
    "Inspect:\n- src\n- test",
    "--force",
    "--branch main",
    "extra instructions --commit abcdef0",
    '"--base" docs',
  ])(
    "passes the normalized argument tail unchanged as custom instructions: %j",
    async (instructions) => {
      const context = await bindReviewThread();
      const codexControlRequest = vi.fn(async () => undefined);

      const result = await runCommand(`review ${instructions}`, { codexControlRequest }, context);

      expect(codexControlRequest).toHaveBeenCalledExactlyOnceWith(
        {},
        "review/start",
        { threadId: "thread-review", target: { type: "custom", instructions } },
        expect.anything(),
      );
      expect(result.text).toBe(
        "Started Codex review with custom instructions for thread thread-review.",
      );
    },
  );

  it.each([`--base rachel's-fix`, '--base "main', '--commit "abcdef0'])(
    "does not start a review for an unterminated quoted ref: %s",
    async (args) => {
      const context = await bindReviewThread();
      const codexControlRequest = vi.fn();

      const result = await runCommand(`review ${args}`, { codexControlRequest }, context);

      expect(codexControlRequest).not.toHaveBeenCalled();
      expect(result.text).toBe(usage);
    },
  );

  it("reports a rejected native review instead of acknowledging it as started", async () => {
    const context = await bindReviewThread();
    const codexControlRequest = vi.fn(async () => {
      throw new Error("base branch not found");
    });

    const result = await runCommand("review --base nowhere", { codexControlRequest }, context);

    expect(codexControlRequest).toHaveBeenCalledOnce();
    expect(result.text).toBe("Codex command failed: base branch not found");
  });

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
