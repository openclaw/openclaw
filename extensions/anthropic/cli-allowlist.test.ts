import { access } from "node:fs/promises";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import * as tempPath from "openclaw/plugin-sdk/temp-path";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectClaudeCli,
  createCliTestHarness,
  resultDetail,
} from "./cli-runtime.test-support.js";

const hostPlatform = process.platform;
const harness = createCliTestHarness("openclaw-claude-allowlist-");
const fixture = `
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const send = value => console.log(JSON.stringify(value));
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "user") {
    const settings = args[args.lastIndexOf("--settings") + 1];
    const inline = settings.startsWith("{");
    send({ type: "result", subtype: "success", result: JSON.stringify({ args, settingsPath: inline ? undefined : settings, settings: JSON.parse(inline ? settings : readFileSync(settings, "utf8")) }) });
  }
});
`;

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

it.each(["separate", "equals"])(
  "starts an oversized Windows allowlist with %s settings",
  async (form) => {
    const tools = Array.from(
      { length: 900 },
      (_, i) => `mcp__openclaw__server_${i}__synthetic_action`,
    );
    const settings = {
      disableAllHooks: true,
      enabledPlugins: {},
      autoMemoryEnabled: false,
      claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude/rules/**"],
    };
    const context = await harness.context(fixture, { liveSession: harness.liveSession() });
    context.args = [
      ...context.args,
      "--settings",
      '{"model":"earlier-settings"}',
      ...(form === "equals"
        ? [`--settings=${JSON.stringify(settings)}`]
        : ["--settings", JSON.stringify(settings)]),
      "--allowedTools",
      tools.join(","),
      "--tools",
      "Read",
      "--disallowedTools",
      "Bash,Write",
    ];
    if (process.platform !== "win32") {
      // Linux cannot reproduce CreateProcess's total command limit. Inject only
      // that OS error; the retry still launches the real owned subprocess.
      vi.spyOn(processRuntime, "createOwnedStdioProcess").mockImplementationOnce(async () => {
        vi.spyOn(process, "platform", "get")
          .mockReturnValue(hostPlatform)
          .mockReturnValueOnce("win32");
        throw Object.assign(new Error("spawn ENAMETOOLONG"), { code: "ENAMETOOLONG" });
      });
    }
    const detail = resultDetail(await collectClaudeCli(context));
    const args = detail.args as string[];
    expect(args).not.toContain("--allowedTools");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Bash,Write");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(detail.settings).toEqual({
      ...settings,
      permissions: { allow: tools },
    });
    const handle = context.liveSession?.current();
    handle?.close("restart");
    await handle?.waitForExit();
    await expect(access(String(detail.settingsPath))).rejects.toThrow();
  },
);

it("keeps fitting commands inline even when temporary settings cannot be created", async () => {
  const write = vi.spyOn(tempPath, "tempWorkspace").mockRejectedValue(new Error("Not writable"));
  const context = await harness.context(fixture);
  context.args = [...context.args, "--settings", "{}", "--allowedTools", "mcp__openclaw__message"];
  const detail = resultDetail(await collectClaudeCli(context));
  expect(detail.args).toContain("--allowedTools");
  expect(detail.settingsPath).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
});

it.each([
  { permissions: { deny: ["Read(/secrets/**)"] } },
  { sandbox: { filesystem: { denyRead: ["/secrets/**"] } } },
])("retains the original failure for caller-owned settings %j", async (settings) => {
  const context = await harness.context(fixture);
  context.args = [
    ...context.args,
    "--settings",
    JSON.stringify(settings),
    "--allowedTools",
    "mcp__openclaw__message",
  ];
  const failure = Object.assign(new Error("spawn ENAMETOOLONG"), { code: "ENAMETOOLONG" });
  const spawn = vi
    .spyOn(processRuntime, "createOwnedStdioProcess")
    .mockImplementationOnce(async () => {
      vi.spyOn(process, "platform", "get")
        .mockReturnValue(hostPlatform)
        .mockReturnValueOnce("win32");
      throw failure;
    });
  const write = vi.spyOn(tempPath, "tempWorkspace");
  await expect(collectClaudeCli(context)).rejects.toBe(failure);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
});

it.each(["write failure", "retired turn", "retry failure"])(
  "removes relocated settings after %s without admitting another command",
  async (failure) => {
    const context = await harness.context(fixture);
    context.args = [
      ...context.args,
      "--settings",
      "{}",
      "--allowedTools",
      "mcp__openclaw__message",
    ];
    let active = true;
    context.assertCurrent = () => {
      if (!active) {
        throw new Error("Retired turn");
      }
    };
    const spawn = vi.spyOn(processRuntime, "createOwnedStdioProcess");
    spawn.mockImplementationOnce(async () => {
      vi.spyOn(process, "platform", "get")
        .mockReturnValue(hostPlatform)
        .mockReturnValueOnce("win32");
      throw Object.assign(new Error("spawn ENAMETOOLONG"), { code: "ENAMETOOLONG" });
    });
    spawn.mockRejectedValueOnce(new Error("Retry failed"));
    const workspace = tempPath.tempWorkspace;
    let dir: string | undefined;
    vi.spyOn(tempPath, "tempWorkspace").mockImplementation(async (options) => {
      const created = await workspace({ ...options, rootDir: context.cwd });
      dir = created.dir;
      return {
        ...created,
        writeJson: async (...args) => {
          if (failure === "write failure") {
            throw new Error("Not writable");
          }
          const file = await created.writeJson(...args);
          active = failure !== "retired turn";
          return file;
        },
      };
    });
    const message =
      failure === "write failure"
        ? "Not writable"
        : failure === "retired turn"
          ? "Retired turn"
          : "Retry failed";
    await expect(collectClaudeCli(context)).rejects.toThrow(message);
    expect(spawn).toHaveBeenCalledTimes(failure === "retry failure" ? 2 : 1);
    expect(dir).toBeDefined();
    await expect(access(dir!)).rejects.toThrow();
  },
);
