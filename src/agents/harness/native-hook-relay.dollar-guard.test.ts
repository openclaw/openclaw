// Codex-native shell commands reach OpenClaw policy through the PreToolUse
// relay; the `$<digit>` guard must deny them there before Codex runs them.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeHookRelayEventHasLocalWork,
  nativeHookRelayEventToolMatcher,
} from "./native-hook-relay-events.js";
import { invokeNativeHookRelay, registerNativeHookRelay, testing } from "./native-hook-relay.js";

afterEach(async () => {
  delete process.env.OPENCLAW_EXEC_DOLLAR_GUARD;
  await testing.clearNativeHookRelaysForTests();
});

function registerPreToolUseRelay() {
  return registerNativeHookRelay({
    provider: "codex",
    relayId: `dollar-guard-${randomUUID()}`,
    sessionId: "session-1",
    runId: "run-dollar-guard",
    allowedEvents: ["pre_tool_use"],
  });
}

function readDecision(stdout: string): { permissionDecision?: string; reason?: string } {
  if (!stdout.trim()) {
    return {};
  }
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  return {
    permissionDecision: parsed.hookSpecificOutput?.permissionDecision,
    reason: parsed.hookSpecificOutput?.permissionDecisionReason,
  };
}

describe("native PreToolUse dollar-expansion guard", () => {
  it("denies a Codex Bash command that would turn $900 into 00", async () => {
    const relay = registerPreToolUseRelay();
    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "call-dollar-1",
        tool_input: {
          command:
            'bash scripts/make-call.sh --to "+15555550101" --context "The unit remains listed and vacant at $900."',
        },
      },
    });
    const decision = readDecision(response.stdout);
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.reason).toContain("vacant at 00.");
  });

  it("denies exec_command argv that wraps the script in bash -lc", async () => {
    const relay = registerPreToolUseRelay();
    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        tool_name: "exec_command",
        tool_use_id: "call-dollar-2",
        tool_input: {
          cmd: [
            "/bin/bash",
            "-lc",
            'openclaw message send --channel telegram --message "The ledger still shows the $1,000 October charge" --json',
          ],
        },
      },
    });
    const decision = readDecision(response.stdout);
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.reason).toContain("shows the ,000 October");
  });

  it("lets single-quoted dollar amounts through", async () => {
    const relay = registerPreToolUseRelay();
    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "call-dollar-3",
        tool_input: { command: "bash scripts/send-sms.sh --message 'Rent is $900 per month'" },
      },
    });
    expect(readDecision(response.stdout).permissionDecision).not.toBe("deny");
    expect(response.exitCode).toBe(0);
  });
});

describe("native PreToolUse relay planning for the dollar-expansion guard", () => {
  const policy = { preToolUseLoopDetection: false };

  it("plans PreToolUse for exec even when no other tool policy is installed", () => {
    expect(nativeHookRelayEventHasLocalWork(policy, "pre_tool_use")).toBe(true);
    expect(nativeHookRelayEventToolMatcher(policy, "pre_tool_use")).toEqual(["exec"]);
  });

  it("keeps exec in a relay scoped to other tools", () => {
    const matcher = nativeHookRelayEventToolMatcher(
      { ...policy, executionAdmissionToolNames: ["write"] },
      "pre_tool_use",
    );
    expect(matcher).toEqual(expect.arrayContaining(["write", "exec"]));
  });

  it("plans nothing extra when the guard is disabled", () => {
    process.env.OPENCLAW_EXEC_DOLLAR_GUARD = "off";
    expect(nativeHookRelayEventHasLocalWork(policy, "pre_tool_use")).toBe(false);
  });
});
