import { beforeEach, describe, expect, it } from "vitest";
import {
  createBrowserManageProgram,
  findBrowserManageCall as findCall,
  getBrowserManageGatewayMock,
} from "./browser-cli-manage.test-helpers.js";
import { getBrowserCliRuntimeCapture } from "./browser-cli.test-support.js";

const gateway = getBrowserManageGatewayMock();

function run(...args: string[]) {
  const program = createBrowserManageProgram({ withParentTimeout: true });
  return program.parseAsync(["browser", ...args], { from: "user" });
}

function expectBudget(path: string, timeoutMs: number) {
  const request = findCall(path);
  expect(request?.[1].timeout).toBe(String(timeoutMs + 130_000));
  expect(request?.[2].timeoutMs).toBe(timeoutMs);
}

describe("browser manage timeout option", () => {
  beforeEach(() => {
    gateway.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it.each([
    [["status"], "/", 30000],
    [["tabs"], "/tabs", 30000],
    [["tab"], "/tabs/action", 30000],
    [["tab", "new"], "/tabs/action", 30000],
    [["tab", "label", "tab-1", "work"], "/tabs/action", 30000],
    [["tab", "select", "1"], "/tabs/action", 30000],
    [["tab", "close", "1"], "/tabs/action", 30000],
    [["open", "https://example.com"], "/tabs/open", 30000],
    [["focus", "tab-1"], "/tabs/focus", 30000],
    [["close", "tab-1"], "/tabs/tab-1", 30000],
    [["profiles"], "/profiles", 30000],
    [["system-profiles"], "/system-profiles", 30000],
    [["import-profile"], "/profiles/import", 30000],
    [["reset-profile"], "/reset-profile", 60000],
    [["create-profile", "--name", "work"], "/profiles/create", 60000],
  ] as const)("honors the authored budget for %j", async (args, path, timeout) => {
    await run("--timeout", String(timeout), "--json", ...args);
    expectBudget(path, timeout);
  });

  it("combines browser profile with browser start --headless", async () => {
    await run("--timeout", "60000", "--browser-profile", "work", "start", "--headless");
    expect(findCall("/start")?.[2].query).toEqual({ profile: "work", headless: "true" });
    expectBudget("/start", 60000);
    expect(findCall("/")?.[2].timeoutMs).toBe(60000);
  });

  it("rejects invalid authored timeouts before dispatch", async () => {
    await expect(run("tabs", "--timeout", "0")).rejects.toThrow(
      "--timeout must be a positive integer.",
    );
    expect(gateway).not.toHaveBeenCalled();
  });

  it("keeps the deep snapshot bounded independently of the management timeout", async () => {
    gateway
      .mockResolvedValueOnce({
        status: { enabled: true, running: true, profile: "work" },
        checks: [],
      })
      .mockResolvedValueOnce({ profiles: [] })
      .mockResolvedValueOnce({ tabs: [] })
      .mockResolvedValueOnce({ format: "aria", nodes: [{}] });
    await run("--json", "--timeout", "60000", "doctor", "--deep");
    for (const route of ["/doctor", "/profiles", "/tabs", "/snapshot"]) {
      expectBudget(route, route === "/snapshot" ? 10000 : 60000);
    }
    expect(gateway.mock.calls.filter((call) => call[2].path === "/snapshot")).toHaveLength(1);
  });

  it("honors the authored budget on both stop and its status readback", async () => {
    await run("--timeout", "60000", "stop");
    for (const route of ["/stop", "/"]) {
      expectBudget(route, 60000);
    }
  });
});
