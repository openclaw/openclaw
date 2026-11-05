import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBrowserMachineOutput } from "../../cli-output-mode.js";
import {
  getBrowserCliRuntimeCapture,
  mockBrowserCliRuntime,
  mockBrowserGateway,
} from "./browser-cli.test-support.js";

const gateway = mockBrowserGateway();
const capture = getBrowserCliRuntimeCapture();
const runtime = mockBrowserCliRuntime();
const { registerBrowserCli } = await import("./browser-cli.js");

async function run(command: string, positionalOptions = true) {
  const args = command.split(" ");
  const program = new Command().name("openclaw");
  if (positionalOptions) {
    program.enablePositionalOptions();
  }
  registerBrowserCli(program, ["node", "openclaw", ...args]);
  await program.parseAsync(args, { from: "user" });
  return gateway.mock.calls.at(-1);
}

describe("registerBrowserCli lazy browser subcommands", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    gateway.mockReset().mockResolvedValue({ ok: true });
    capture.resetRuntimeCapture();
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["storage session get key", true],
    ["extension uninstall-host --json", true],
    ["status", false],
    ["cookies set", false],
    ["--log-level debug evaluate", true],
  ] as const)("detects machine output for %s", (args, machine) => {
    expect(
      isBrowserMachineOutput({ argv: ["node", "openclaw", "browser", ...args.split(" ")] }),
    ).toBe(machine);
  });

  it("loads browser doctor from the manage group so --deep is available", async () => {
    gateway.mockResolvedValueOnce({ status: { enabled: true, running: true }, checks: [] });
    gateway.mockResolvedValueOnce({ profiles: [] });
    gateway.mockResolvedValueOnce({ tabs: [] });
    gateway.mockResolvedValueOnce({ format: "ai", snapshot: "ok" });
    const call = await run("browser --json doctor --deep", false);
    expect(call?.[2]).toMatchObject({ path: "/snapshot", query: { format: "aria", limit: "25" } });
  });

  it("keeps explicit Gateway and wait URLs under their separate owners", async () => {
    const call = await run("browser --url ws://127.0.0.1:18789 wait --url **/done");
    expect(call?.[1]).toMatchObject({ url: "ws://127.0.0.1:18789" });
    expect(call?.[2]).toMatchObject({ path: "/act", body: { kind: "wait", url: "**/done" } });
  });

  it("accepts trailing profile and timeout options after lazy loading", async () => {
    gateway.mockResolvedValueOnce({ tabs: [] });
    const call = await run("browser tabs --browser-profile remote --timeout 60000");
    expect(call?.[2]).toMatchObject({
      path: "/tabs",
      query: { profile: "remote" },
      timeoutMs: 60000,
    });
  });

  it("preserves parent options before a nested lazy leaf", async () => {
    const call = await run(
      "browser --timeout 60000 --browser-profile work --json cookies set session abc --url https://example.com",
    );
    expect(call?.[2]).toMatchObject({
      path: "/cookies/set",
      query: { profile: "work" },
      timeoutMs: 60000,
    });
    expect(capture.runtimeLogs.map((line) => JSON.parse(line))).toEqual([{ ok: true }]);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("eagerly registers usable browser commands", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_LAZY_SUBCOMMANDS", "1");
    const program = new Command().name("openclaw").enablePositionalOptions();
    registerBrowserCli(program, ["node", "openclaw", "browser", "--help"]);
    await vi.dynamicImportSettled();
    await program.parseAsync(
      "browser --json cookies set session abc --url https://example.com".split(" "),
      { from: "user" },
    );
    expect(gateway.mock.calls.at(-1)?.[2]).toMatchObject({ path: "/cookies/set" });
  });
});
