import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setFsSafeTestHooksForTest } from "../infra/fs-safe.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { __testing, createExecTool } from "./bash-tools.exec.js";

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: async () => ({ allowWithoutEnforcedCommand: true }),
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: async () => {
    throw new Error("node host execution is not used by script preflight tests");
  },
}));

vi.mock("../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: (value: unknown) => value,
}));

const isWin = process.platform === "win32";

const describeNonWin = isWin ? describe.skip : describe;
const describeWin = isWin ? describe : describe.skip;
const parseOpenClawChannelsLoginShellCommand = __testing.parseOpenClawChannelsLoginShellCommand;
const parseOpenClawMessageDeliveryShellCommand = __testing.parseOpenClawMessageDeliveryShellCommand;
const validateExecScriptPreflight = __testing.validateScriptFileForShellBleed;
const createPreflightTool = () =>
  createExecTool({ host: "gateway", security: "full", ask: "on-miss" });

afterEach(() => {
  __setFsSafeTestHooksForTest();
});

async function expectSymlinkSwapDuringPreflightToAvoidErrors(params: {
  hookName: "afterPreOpenLstat" | "beforeOpen";
}) {
  await withTempDir("openclaw-exec-preflight-open-race-", async (parent) => {
    const workdir = path.join(parent, "workdir");
    const scriptPath = path.join(workdir, "script.js");
    const outsidePath = path.join(parent, "outside.js");
    await fs.mkdir(workdir, { recursive: true });
    await fs.writeFile(scriptPath, 'console.log("inside")', "utf-8");
    await fs.writeFile(outsidePath, 'console.log("$DM_JSON outside")', "utf-8");
    const scriptRealPath = await fs.realpath(scriptPath);

    let swapped = false;
    __setFsSafeTestHooksForTest({
      [params.hookName]: async (target: string) => {
        if (swapped || path.resolve(target) !== scriptRealPath) {
          return;
        }
        await fs.rm(scriptPath, { force: true });
        await fs.symlink(outsidePath, scriptPath);
        swapped = true;
      },
    });

    await expect(
      validateExecScriptPreflight({
        command: "node script.js",
        workdir,
      }),
    ).resolves.toBeUndefined();
    expect(swapped).toBe(true);
  });
}

describe("exec interactive OpenClaw channel login guard", () => {
  it("recognizes direct and package-runner channel login commands before execution", () => {
    expect(
      parseOpenClawChannelsLoginShellCommand("openclaw channels login --channel whatsapp"),
    ).toBe(true);
    expect(
      parseOpenClawChannelsLoginShellCommand(
        "pnpm exec openclaw channels login --channel whatsapp --verbose",
      ),
    ).toBe(true);
    expect(parseOpenClawChannelsLoginShellCommand("openclaw channels status --deep")).toBe(false);
  });

  it("blocks interactive channel login commands from exec", async () => {
    const tool = createPreflightTool();

    await expect(
      tool.execute("call-openclaw-channel-login", {
        command: "openclaw channels login --channel whatsapp --verbose",
      }),
    ).rejects.toThrow(/exec cannot run interactive OpenClaw channel login commands/);
    await expect(
      tool.execute("call-wrapped-openclaw-channel-login", {
        command: "sudo -u openclaw bash -lc 'openclaw channels login --channel whatsapp'",
      }),
    ).rejects.toThrow(/exec cannot run interactive OpenClaw channel login commands/);
  });
});

describe("exec OpenClaw message delivery guard", () => {
  it("recognizes real message delivery commands before execution", () => {
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm openclaw -- message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "corepack pnpm openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm exec openclaw message send --channel telegram --target 123 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw -- message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "./openclaw.mjs message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "node openclaw.mjs message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm exec node openclaw.mjs message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "npm exec node dist/entry.js message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm -c exec 'openclaw message send --channel whatsapp --target +1555 --message hi'",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm --shell-mode exec 'openclaw message send --channel whatsapp --target +1555 --message hi'",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm dlx openclaw@latest message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "/usr/bin/env openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "/usr/bin/env -S openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "/usr/bin/env -S'openclaw message send' --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "/usr/bin/env -iS'openclaw message send' --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "echo hi > /tmp/openclaw-message-send-preflight; openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "> /tmp/openclaw-message-send-preflight openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "2>/tmp/openclaw-message-send-preflight.err openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "echo ok > /tmp/openclaw-message-send-preflight; printf hi | openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        'echo "<<EOF"\nopenclaw message send --channel whatsapp --target +1555 --message hi',
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "echo $(openclaw message send --channel whatsapp --target +1555 --message hi)",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "cat <(openclaw message send --channel whatsapp --target +1555 --message hi)",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        'powershell -Command "openclaw message send --channel whatsapp --target +1555 --message hi"',
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "cmd /c openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "sh <<'EOF'\nopenclaw message send --channel whatsapp --target +1555 --message hi\nEOF",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "cat <<'EOF' | sh\nopenclaw message send --channel whatsapp --target +1555 --message hi\nEOF",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "cat <<'EOF' | sudo sh\nopenclaw message send --channel whatsapp --target +1555 --message hi\nEOF",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "bash <<< 'openclaw message send --channel whatsapp --target +1555 --message hi'",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "cat <<< 'openclaw message send --channel whatsapp --target +1555 --message hi' | sh",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "(openclaw message send --channel whatsapp --target +1555 --message hi)",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "( openclaw message send --channel whatsapp --target +1555 --message hi )",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "{ openclaw message send --channel whatsapp --target +1555 --message hi; }",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "if true; then openclaw message send --channel whatsapp --target +1555 --message hi; fi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "sleep 1 & openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "! openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message \\\nsend --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm openclaw message \\\nsend --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message s\\\nend --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm openclaw --profile work message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm -s --dir . openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm --loglevel silent openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm --reporter append-only openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpm exec -w openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "npm --prefix . run openclaw -- message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "npm --loglevel silent exec openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "npm exec openclaw -- message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "npm run-script openclaw -- message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "npm x openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "npm -w apps/cli run openclaw -- message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "npm --workspace apps/cli run openclaw -- message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "yarn workspace app openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "yarn openclaw -- message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "bun run openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "npm exec -c 'openclaw message send --channel whatsapp --target +1555 --message hi'",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "npm exec -c 'OPENCLAW_GATEWAY_TOKEN=secret openclaw message send --channel whatsapp --target +1555 --message hi'",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "npm exec -c 'sudo -u openclaw openclaw message send --channel whatsapp --target +1555 --message hi'",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "sudo env -S 'openclaw message send --channel whatsapp --target +1555 --message hi'",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        'npm exec --call="openclaw message send --channel whatsapp --target +1555 --message hi"',
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "npx -c 'openclaw message send --channel whatsapp --target +1555 --message hi'",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "pnpx openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "eval 'openclaw message send --channel whatsapp --target +1555 --message hi'",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "eval openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message --profile work send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "sudo -Eu openclaw openclaw message send --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message send --channel whatsapp --target +1555 --message --help",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message send --channel whatsapp --target +1555 --message --dry-run",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message send --channel whatsapp --target +1555 --message=-h",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message broadcast --targets +1555 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message poll --channel telegram --target 123 --poll-question Snack --poll-option Pizza --poll-option Sushi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message thread reply --channel discord --target thread:123 --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message thread create --channel discord --target channel:123 --thread-name Updates --message hi",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message sticker send --channel discord --target channel:123 --sticker-id 456",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message broadcast --targets +1555 --message --help",
      ),
    ).toBe(true);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message poll --channel telegram --target 123 --poll-question Snack --poll-option --dry-run --poll-option Sushi",
      ),
    ).toBe(true);
    expect(parseOpenClawMessageDeliveryShellCommand("openclaw message --help")).toBe(false);
    expect(parseOpenClawMessageDeliveryShellCommand("openclaw message send --help")).toBe(false);
    expect(parseOpenClawMessageDeliveryShellCommand("openclaw message broadcast --help")).toBe(
      false,
    );
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message send --dry-run --channel whatsapp --target +1555 --message hi",
      ),
    ).toBe(false);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "openclaw message poll --dry-run --channel telegram --target 123 --poll-question Snack --poll-option Pizza --poll-option Sushi",
      ),
    ).toBe(false);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "cat > send.sh <<'EOF'\nopenclaw message send --channel whatsapp --target +1555 --message hi\nEOF",
      ),
    ).toBe(false);
    expect(
      parseOpenClawMessageDeliveryShellCommand(
        "cat > send.sh <<'EOF'\necho $(openclaw message send --channel whatsapp --target +1555 --message hi)\nEOF",
      ),
    ).toBe(false);
    expect(
      parseOpenClawMessageDeliveryShellCommand("openclaw message read --target channel:123"),
    ).toBe(false);
    expect(
      parseOpenClawMessageDeliveryShellCommand("openclaw message search --guild-id 1 --query hi"),
    ).toBe(false);
    expect(
      parseOpenClawMessageDeliveryShellCommand("openclaw message thread list --guild-id 1"),
    ).toBe(false);
    expect(
      parseOpenClawMessageDeliveryShellCommand("openclaw --profile work message read --target 123"),
    ).toBe(false);
  });

  it("blocks message delivery commands from exec", async () => {
    const tool = createPreflightTool();

    await expect(
      tool.execute("call-openclaw-message-send", {
        command:
          'OPENCLAW_GATEWAY_TOKEN=secret pnpm openclaw message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-wrapped-openclaw-message-send", {
        command:
          "sudo -u openclaw bash -lc 'openclaw message send --channel whatsapp --target +1555 --message hello'",
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-broadcast", {
        command: 'openclaw message broadcast --targets +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-poll", {
        command:
          'openclaw message poll --channel telegram --target 123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-thread-reply", {
        command: 'openclaw message thread reply --target thread:123 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-thread-create", {
        command:
          'openclaw message thread create --target channel:123 --thread-name Updates --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-sticker-send", {
        command: "openclaw message sticker send --target channel:123 --sticker-id 456",
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-npm-call", {
        command:
          'npm exec --call="openclaw message send --channel whatsapp --target +1555 --message hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-npm-call-env", {
        command:
          "npm exec -c 'OPENCLAW_GATEWAY_TOKEN=secret openclaw message send --channel whatsapp --target +1555 --message hello'",
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-pnpm-shell-mode", {
        command:
          "pnpm -c exec 'openclaw message send --channel whatsapp --target +1555 --message hello'",
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-pnpm-dlx-versioned", {
        command:
          'pnpm dlx openclaw@latest message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-sudo-env-split", {
        command:
          "sudo env -S 'openclaw message send --channel whatsapp --target +1555 --message hello'",
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-path-env", {
        command:
          '/usr/bin/env openclaw message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-after-redirect", {
        command:
          'echo hi > /tmp/openclaw-message-send-preflight; openclaw message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-command-substitution", {
        command:
          'echo $(openclaw message send --channel whatsapp --target +1555 --message "hello")',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-process-substitution", {
        command: 'cat <(openclaw message send --channel whatsapp --target +1555 --message "hello")',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-powershell", {
        command:
          'powershell -Command "openclaw message send --channel whatsapp --target +1555 --message hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-cmd", {
        command: 'cmd /c openclaw message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-shell-heredoc", {
        command:
          "sh <<'EOF'\nopenclaw message send --channel whatsapp --target +1555 --message \"hello\"\nEOF",
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-piped-shell-heredoc", {
        command:
          "cat <<'EOF' | sh\nopenclaw message send --channel whatsapp --target +1555 --message \"hello\"\nEOF",
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-shell-here-string", {
        command:
          "bash <<< 'openclaw message send --channel whatsapp --target +1555 --message \"hello\"'",
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-piped-shell-here-string", {
        command:
          "cat <<< 'openclaw message send --channel whatsapp --target +1555 --message \"hello\"' | sh",
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-grouped", {
        command: '(openclaw message send --channel whatsapp --target +1555 --message "hello")',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-spaced-grouped", {
        command: '( openclaw message send --channel whatsapp --target +1555 --message "hello" )',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-braced", {
        command: '{ openclaw message send --channel whatsapp --target +1555 --message "hello"; }',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-if-then", {
        command:
          'if true; then openclaw message send --channel whatsapp --target +1555 --message "hello"; fi',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-after-background", {
        command:
          'sleep 1 & openclaw message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-negated", {
        command: '! openclaw message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-line-continuation", {
        command: 'openclaw message \\\nsend --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-root-terminator", {
        command: 'openclaw -- message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-node-mjs", {
        command:
          'node openclaw.mjs message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-pnpm-node-mjs", {
        command:
          'pnpm exec node openclaw.mjs message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-leading-redirection", {
        command:
          '> /tmp/openclaw-message-send-preflight openclaw message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-bun-run", {
        command:
          'bun run openclaw message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-npm-run-script", {
        command:
          'npm run-script openclaw -- message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-eval", {
        command:
          "eval 'openclaw message send --channel whatsapp --target +1555 --message \"hello\"'",
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-pnpx", {
        command: 'pnpx openclaw message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-corepack-pnpm", {
        command:
          'corepack pnpm openclaw message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    await expect(
      tool.execute("call-openclaw-message-send-sudo-clustered-user", {
        command:
          'sudo -Eu openclaw openclaw message send --channel whatsapp --target +1555 --message "hello"',
      }),
    ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
  });
});

describeNonWin("exec script preflight", () => {
  it("blocks shell env var injection tokens in python scripts before execution", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");

      await fs.writeFile(
        pyPath,
        [
          "import json",
          "# model accidentally wrote shell syntax:",
          "payload = $DM_JSON",
          "print(payload)",
        ].join("\n"),
        "utf-8",
      );

      const tool = createPreflightTool();

      await expect(
        tool.execute("call1", {
          command: "python bad.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("blocks obvious shell-as-js output before node execution", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "bad.js");

      await fs.writeFile(
        jsPath,
        ['NODE "$TMPDIR/hot.json"', "console.log('hi')"].join("\n"),
        "utf-8",
      );

      const tool = createPreflightTool();

      await expect(
        tool.execute("call1", {
          command: "node bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(
        /exec preflight: (detected likely shell variable injection|JS file starts with shell syntax)/,
      );
    });
  });

  it("blocks shell env var injection when script path is quoted", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "bad.js");
      await fs.writeFile(jsPath, "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-quoted", {
          command: 'node "bad.js"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates in-workdir scripts whose names start with '..'", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "..bad.js");
      await fs.writeFile(jsPath, "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-dotdot-prefix-script", {
          command: "node ..bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates in-workdir symlinked script entrypoints", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const targetPath = path.join(tmp, "bad-target.js");
      const linkPath = path.join(tmp, "link.js");
      await fs.writeFile(targetPath, "const value = $DM_JSON;", "utf-8");
      await fs.symlink(targetPath, linkPath);

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-symlink-entrypoint", {
          command: "node link.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates scripts under literal tilde directories in workdir", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const literalTildeDir = path.join(tmp, "~");
      await fs.mkdir(literalTildeDir, { recursive: true });
      await fs.writeFile(path.join(literalTildeDir, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-literal-tilde-path", {
          command: 'node "~/bad.js"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates python scripts when interpreter is prefixed with env", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-env-python", {
          command: "env python bad.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates python scripts when interpreter is prefixed with path-qualified env", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-abs-env-python", {
          command: "/usr/bin/env python bad.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates node scripts when interpreter is prefixed with env", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "bad.js");
      await fs.writeFile(jsPath, "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-env-node", {
          command: "env node bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates the first positional python script operand when extra args follow", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.py"), "payload = $DM_JSON", "utf-8");
      await fs.writeFile(path.join(tmp, "ghost.py"), "print('ok')", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-python-first-script", {
          command: "python bad.py ghost.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates python script operand even when trailing option values look like scripts", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "script.py"), "payload = $DM_JSON", "utf-8");
      await fs.writeFile(path.join(tmp, "out.py"), "print('ok')", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-python-trailing-option-value", {
          command: "python script.py --output out.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates the first positional node script operand when extra args follow", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "app.js"), "const value = $DM_JSON;", "utf-8");
      await fs.writeFile(path.join(tmp, "config.js"), "console.log('ok')", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-first-script", {
          command: "node app.js config.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("still resolves node script when --require consumes a preceding .js option value", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bootstrap.js"), "console.log('bootstrap')", "utf-8");
      await fs.writeFile(path.join(tmp, "app.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-require-script", {
          command: "node --require bootstrap.js app.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates node --require preload modules before a benign entry script", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad-preload.js"), "const value = $DM_JSON;", "utf-8");
      await fs.writeFile(path.join(tmp, "app.js"), "console.log('ok')", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-preload-before-entry", {
          command: "node --require bad-preload.js app.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates node --require preload modules when no entry script is provided", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-require-only", {
          command: "node --require bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates node --import preload modules when no entry script is provided", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-import-only", {
          command: "node --import bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates node --require preload modules even when -e is present", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-require-with-eval", {
          command: 'node --require bad.js -e "console.log(123)"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates node --import preload modules even when -e is present", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-node-import-with-eval", {
          command: 'node --import bad.js -e "console.log(123)"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("blocks OpenClaw message delivery commands inside shell scripts before execution", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(
        path.join(tmp, "send.sh"),
        [
          "#!/usr/bin/env bash",
          'openclaw message send --channel whatsapp --target +1555 --message "hello"',
        ].join("\n"),
        "utf-8",
      );

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-shell-script-send", {
          command: "bash send.sh",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
      await expect(
        tool.execute("call-sh-script-send", {
          command: "sh ./send.sh",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
      await expect(
        tool.execute("call-chained-shell-script-send", {
          command: "true && sh send.sh",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
      await expect(
        tool.execute("call-shell-payload-script-send", {
          command: "bash -c './send.sh'",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
      await expect(
        tool.execute("call-direct-shell-script-send", {
          command: "./send.sh",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
      await expect(
        tool.execute("call-source-shell-script-send", {
          command: "source ./send.sh",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
      await expect(
        tool.execute("call-dot-source-shell-script-send", {
          command: ". ./send.sh",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);

      await fs.writeFile(path.join(tmp, "ok.js"), "console.log('ok')", "utf-8");
      await expect(
        tool.execute("call-mixed-node-and-shell-script-send", {
          command: "node ok.js && sh send.sh",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    });
  });

  it("validates shell script targets reached through env split-string", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(
        path.join(tmp, "send.sh"),
        'openclaw message send --channel whatsapp --target +1555 --message "hello"',
        "utf-8",
      );

      await expect(
        validateExecScriptPreflight({
          command: 'env -S "bash send.sh"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    });
  });

  it("skips script-file preflight in yolo host mode", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "bad.js");
      await fs.writeFile(jsPath, "const value = $DM_JSON;", "utf-8");

      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        allowBackground: false,
      });
      const result = await tool.execute("call-yolo-bad-js", {
        command: "node bad.js",
        workdir: tmp,
      });
      const text = result.content.find((c) => c.type === "text")?.text ?? "";

      expect(text).not.toMatch(/exec preflight:/);
      expect(result.details).toMatchObject({
        status: expect.stringMatching(/completed|failed/),
      });

      await fs.writeFile(
        path.join(tmp, "send.sh"),
        'openclaw message send --channel whatsapp --target +1555 --message "hello"',
        "utf-8",
      );
      await expect(
        tool.execute("call-yolo-shell-message-send", {
          command: "sh send.sh",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);
    });
  });

  it("runs heredoc-backed node commands in yolo host mode", async () => {
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: false,
    });
    const result = await tool.execute("call-yolo-heredoc", {
      command: "node <<'NODE'\nprocess.stdout.write('ok')\nNODE",
    });
    const text = result.content.find((c) => c.type === "text")?.text?.trim();

    expect(result.details).toMatchObject({ status: "completed" });
    expect(text).toBe("ok");
  });

  it("skips preflight file reads for script paths outside the workdir", async () => {
    await withTempDir("openclaw-exec-preflight-parent-", async (parent) => {
      const outsidePath = path.join(parent, "outside.js");
      const workdir = path.join(parent, "workdir");
      await fs.mkdir(workdir, { recursive: true });
      await fs.writeFile(outsidePath, "const value = $DM_JSON;", "utf-8");

      await expect(
        validateExecScriptPreflight({
          command: "node ../outside.js",
          workdir,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("validates readable shell script paths outside the workdir", async () => {
    await withTempDir("openclaw-exec-preflight-parent-", async (parent) => {
      const workdir = path.join(parent, "workdir");
      await fs.mkdir(workdir, { recursive: true });
      await fs.writeFile(
        path.join(parent, "send.sh"),
        'openclaw message send --channel whatsapp --target +1555 --message "hello"',
        "utf-8",
      );

      await expect(
        validateExecScriptPreflight({
          command: "bash ../send.sh",
          workdir,
        }),
      ).rejects.toThrow(/exec cannot run OpenClaw message delivery commands/);

      await fs.writeFile(path.join(parent, "safe.sh"), "echo ok", "utf-8");
      await expect(
        validateExecScriptPreflight({
          command: "bash ../safe.sh",
          workdir,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("does not trust a swapped script pathname between validation and read", async () => {
    await expectSymlinkSwapDuringPreflightToAvoidErrors({
      hookName: "afterPreOpenLstat",
    });
  });

  it("handles pre-open symlink swaps without surfacing preflight errors", async () => {
    await expectSymlinkSwapDuringPreflightToAvoidErrors({
      hookName: "beforeOpen",
    });
  });

  it("opens preflight script reads with O_NONBLOCK to avoid FIFO stalls", async () => {
    await withTempDir("openclaw-exec-preflight-nonblock-", async (tmp) => {
      const scriptPath = path.join(tmp, "script.js");
      await fs.writeFile(scriptPath, 'console.log("ok")', "utf-8");
      const scriptRealPath = await fs.realpath(scriptPath);

      const scriptOpenFlags: number[] = [];
      __setFsSafeTestHooksForTest({
        beforeOpen: (target, flags) => {
          if (path.resolve(target) === scriptRealPath) {
            scriptOpenFlags.push(flags);
          }
        },
      });

      await expect(
        validateExecScriptPreflight({
          command: "node script.js",
          workdir: tmp,
        }),
      ).resolves.toBeUndefined();
      expect(scriptOpenFlags.length).toBeGreaterThan(0);
      expect(scriptOpenFlags.some((flags) => (flags & fsConstants.O_NONBLOCK) !== 0)).toBe(true);
    });
  });

  const failClosedCases = [
    ["piped interpreter command", "cat bad.py | python"],
    ["top-level control-flow", "if true; then python bad.py; fi"],
    ["multiline top-level control-flow", "if true; then\npython bad.py\nfi"],
    ["shell-wrapped quoted script path", `bash -c "python 'bad.py'"`],
    ["top-level control-flow with quoted script path", 'if true; then python "bad.py"; fi'],
    ["shell-wrapped interpreter", 'bash -c "python bad.py"'],
    ["shell-wrapped control-flow payload", 'bash -c "if true; then python bad.py; fi"'],
    ["env-prefixed shell wrapper", 'env bash -c "python bad.py"'],
    ["absolute shell path", '/bin/bash -c "python bad.py"'],
    ["long option with separate value", 'bash --rcfile shell.rc -c "python bad.py"'],
    ["leading long options", 'bash --noprofile --norc -c "python bad.py"'],
    ["combined shell flags", 'bash -xc "python bad.py"'],
    ["-O option value", 'bash -O extglob -c "python bad.py"'],
    ["-o option value", 'bash -o errexit -c "python bad.py"'],
    ["-c not trailing short flag", 'bash -ceu "python bad.py"'],
    ["process substitution", "python <(cat bad.py)"],
  ] as const;

  it.each(failClosedCases)("fails closed for %s", async (_name, command) => {
    await expect(
      validateExecScriptPreflight({
        command,
        workdir: process.cwd(),
      }),
    ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
  });

  const passCases = [
    ["shell-wrapped echoed interpreter words", 'bash -c "echo python"'],
    ["direct inline interpreter command", 'node -e "console.log(123)"'],
    ["interpreter and script hints only in echoed text", "echo 'python bad.py | python'"],
    ["shell keyword-like text only as echo arguments", "echo time python bad.py; cat"],
    ["pipeline containing only interpreter words as plain text", "echo python | cat"],
    ["non-executing pipeline that only prints interpreter words", "printf node | wc -c"],
    ["script-like text in a separate command segment", "echo bad.py; python --version"],
    ["script hints outside interpreter segment with &&", "node --version && ls *.py"],
    [
      "piped interpreter version command with script-like upstream text",
      "echo bad.py | node --version",
    ],
    ["piped node -c command with script-like upstream text", "echo bad.py | node -c ok.js"],
    [
      "piped node -e command with inline script-like text",
      "node -e \"console.log('bad.py')\" | cat",
    ],
    ["escaped shell operator characters", "echo python bad.py \\| node"],
    ["escaped semicolons with interpreter hints", "echo python bad.py \\; node"],
    ["node -e with .py inside quoted inline code", "node -e \"console.log('bad.py')\""],
  ] as const;

  it.each(passCases)("does not fail closed for %s", async (_name, command) => {
    await expect(
      validateExecScriptPreflight({
        command,
        workdir: process.cwd(),
      }),
    ).resolves.toBeUndefined();
  });
});

describeWin("exec script preflight on windows path syntax", () => {
  it("preserves windows-style python relative path separators during script extraction", async () => {
    await withTempDir("openclaw-exec-preflight-win-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.py"), "payload = $DM_JSON", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-win-python-relative", {
          command: "python .\\bad.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("preserves windows-style node relative path separators during script extraction", async () => {
    await withTempDir("openclaw-exec-preflight-win-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-win-node-relative", {
          command: "node .\\bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("preserves windows-style python absolute drive paths during script extraction", async () => {
    await withTempDir("openclaw-exec-preflight-win-", async (tmp) => {
      const absPath = path.join(tmp, "bad.py");
      await fs.writeFile(absPath, "payload = $DM_JSON", "utf-8");
      const winAbsPath = absPath.replaceAll("/", "\\");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-win-python-absolute", {
          command: `python "${winAbsPath}"`,
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("preserves windows-style nested relative path separators during script extraction", async () => {
    await withTempDir("openclaw-exec-preflight-win-", async (tmp) => {
      await fs.mkdir(path.join(tmp, "subdir"), { recursive: true });
      await fs.writeFile(path.join(tmp, "subdir", "bad.py"), "payload = $DM_JSON", "utf-8");

      const tool = createPreflightTool();
      await expect(
        tool.execute("call-win-python-subdir-relative", {
          command: "python subdir\\bad.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });
});

describe("exec interpreter heuristics ReDoS guard", () => {
  it("does not hang on long commands with VAR=value assignments and whitespace-heavy text", async () => {
    // Simulate a heredoc with HTML content after a VAR= assignment. Keep the
    // command parser check direct so no shell process timing hides regex cost.
    const htmlBlock = '<section style="padding: 30px 20px; font-family: Arial;">'.repeat(50);
    const command = `ACCESS_TOKEN=$(__openclaw_missing_redos_guard__)\ncat > /tmp/out.html << 'EOF'\n${htmlBlock}\nEOF`;

    const start = Date.now();
    await validateExecScriptPreflight({ command, workdir: process.cwd() });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});
