import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserTab } from "../browser/client.js";
import {
  createBrowserManageProgram,
  getBrowserManageGatewayMock,
} from "./browser-cli-manage.test-helpers.js";
import { getBrowserCliRuntimeCapture } from "./browser-cli.test-support.js";

const tabs: BrowserTab[] = [
  { targetId: "mail-target", title: "Inbox", url: "https://mail.example.com" },
  {
    targetId: "docs-target",
    title: "OpenClaw Docs",
    url: "https://docs.example.com/Guide",
    tabId: "t2",
    label: "docs",
    suggestedTargetId: "docs",
  },
  { targetId: "source-target", title: "OpenClaw Source", url: "https://code.example.com" },
  { targetId: "blank-target", title: "", url: "about:blank" },
];

describe("browser tabs filters", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
    getBrowserManageGatewayMock().mockReset().mockResolvedValue({ tabs });
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  async function list(args: string[], json = true) {
    const program = createBrowserManageProgram().exitOverride();
    await program.parseAsync(["browser", ...(json ? ["--json"] : []), "tabs", ...args], {
      from: "user",
    });
    const logs = getBrowserCliRuntimeCapture().runtimeLogs;
    expect(logs).toHaveLength(1);
    expect(getBrowserManageGatewayMock()).toHaveBeenCalledTimes(1);
    expect(getBrowserManageGatewayMock().mock.calls[0]?.[2]).toMatchObject({
      method: "GET",
      path: "/tabs",
    });
    return logs[0] ?? "";
  }

  it.each([
    { args: [], expected: tabs },
    { args: ["--title", "OPENCLAW"], expected: tabs.slice(1, 3) },
    { args: ["--url-contains", "EXAMPLE.COM/GUIDE"], expected: [tabs[1]] },
    { args: ["--title", "openclaw", "--url-contains", "code."], expected: [tabs[2]] },
    { args: ["--title", "missing"], expected: [] },
    { args: ["--title", ".*"], expected: [] },
    { args: ["--title", ""], expected: tabs },
  ])("returns the unchanged tab shape for $args", async ({ args, expected }) => {
    expect(JSON.parse(await list(args))).toEqual({ tabs: expected });
    expect(tabs.map((tab) => tab.targetId)).toEqual([
      "mail-target",
      "docs-target",
      "source-target",
      "blank-target",
    ]);
  });

  it("keeps original ordinals and all tab references in filtered text", async () => {
    expect(await list(["--title", "docs"], false)).toBe(
      "2. OpenClaw Docs [use: docs tab: t2 label:docs]\n   https://docs.example.com/Guide\n   id: docs-target",
    );
  });

  it("uses the existing empty-list message when no tabs match", async () => {
    expect(await list(["--url-contains", "missing"], false)).toBe(
      "No tabs (browser closed or no targets).",
    );
  });

  it("keeps Gateway URL and profile options separate from tab filtering", async () => {
    const program = createBrowserManageProgram().exitOverride();
    program.commands.find((command) => command.name() === "browser")?.option("--url <url>");
    await program.parseAsync(
      [
        "browser",
        "--url",
        "ws://127.0.0.1:18789",
        "--browser-profile",
        "work",
        "--json",
        "tabs",
        "--url-contains",
        "docs.example",
      ],
      { from: "user" },
    );
    expect(getBrowserManageGatewayMock().mock.calls[0]?.[1]).toMatchObject({
      url: "ws://127.0.0.1:18789",
    });
    expect(getBrowserManageGatewayMock().mock.calls[0]?.[2]).toMatchObject({
      method: "GET",
      path: "/tabs",
      query: { profile: "work" },
    });
    expect(JSON.parse(getBrowserCliRuntimeCapture().runtimeLogs[0] ?? "")).toEqual({
      tabs: [tabs[1]],
    });
  });
});
