import { access } from "node:fs/promises";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectClaudeCli,
  createCliTestHarness,
  resultDetail,
} from "./cli-runtime.test-support.js";

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
    send({ type: "result", subtype: "success", result: JSON.stringify({ args, settingsPath: settings, settings: JSON.parse(readFileSync(settings, "utf8")) }) });
  }
});
`;

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

it("starts an oversized Windows tool allowlist with exactly the admitted permissions", async () => {
  const tools = Array.from(
    { length: 900 },
    (_, i) => `mcp__openclaw__server_${i}__synthetic_action`,
  );
  const settings = {
    disableAllHooks: true,
    enabledPlugins: {},
    autoMemoryEnabled: false,
    claudeMdExcludes: ["**/CLAUDE.md"],
    permissions: { allow: ["Read"], deny: ["Write"], defaultMode: "default" },
  };
  const context = await harness.context(fixture, { liveSession: harness.liveSession() });
  context.args.push(
    "--settings",
    JSON.stringify(settings),
    "--allowedTools",
    tools.join(","),
    "--tools",
    "Read",
    "--disallowedTools",
    "Bash,Write",
  );
  if (process.platform !== "win32") {
    // Linux cannot reproduce CreateProcess's total command limit. Inject only
    // that OS error; the retry still launches the real owned subprocess.
    vi.spyOn(processRuntime, "createOwnedStdioProcess").mockImplementationOnce(async () => {
      vi.spyOn(process, "platform", "get").mockReturnValueOnce("win32");
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
    permissions: { ...settings.permissions, allow: ["Read", ...tools] },
  });
  const handle = context.liveSession?.current();
  handle?.close("restart");
  await handle?.waitForExit();
  await expect(access(String(detail.settingsPath))).rejects.toThrow();
});
