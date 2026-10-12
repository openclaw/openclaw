import { beforeEach, describe, expect, it } from "vitest";
import {
  createBrowserManageProgram,
  findBrowserManageCall,
  getBrowserManageGatewayMock,
} from "./browser-cli-manage.test-helpers.js";
import { getBrowserCliRuntimeCapture } from "./browser-cli.test-support.js";

const fixedBudgetRequests = [
  { args: ["status"], path: "/" },
  { args: ["tabs"], path: "/tabs" },
  { args: ["tab"], path: "/tabs/action" },
  { args: ["tab", "new"], path: "/tabs/action" },
  { args: ["tab", "label", "tab-1", "work"], path: "/tabs/action" },
  { args: ["tab", "select", "1"], path: "/tabs/action" },
  { args: ["tab", "close", "1"], path: "/tabs/action" },
  { args: ["open", "https://example.com"], path: "/tabs/open" },
  { args: ["focus", "tab-1"], path: "/tabs/focus" },
  { args: ["close", "tab-1"], path: "/tabs/tab-1" },
  { args: ["profiles"], path: "/profiles" },
  { args: ["system-profiles"], path: "/system-profiles" },
  { args: ["import-profile"], path: "/profiles/import" },
];

describe("browser manage timeout option", () => {
  beforeEach(() => {
    getBrowserManageGatewayMock().mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it("uses parent --timeout for browser start instead of hardcoded 15s", async () => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "--timeout", "60000", "start"], { from: "user" });

    const startCall = findBrowserManageCall("/start");
    if (!startCall) {
      throw new Error("expected browser /start call");
    }
    expect(startCall[1].timeout).toBe("70000");
    expect(startCall[2].timeoutMs).toBe(60000);
    expect(findBrowserManageCall("/")?.[2].timeoutMs).toBe(60000);
  });

  it.each([
    { args: ["reset-profile"], path: "/reset-profile" },
    { args: ["create-profile", "--name", "work"], path: "/profiles/create" },
    { args: ["delete-profile", "--name", "work"], path: "/profiles/work" },
  ])("inherits parent --timeout for $path", async ({ args, path }) => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "--timeout", "60000", "--json", ...args], {
      from: "user",
    });

    const request = findBrowserManageCall(path);
    expect(request?.[1]).toEqual(expect.objectContaining({ timeout: "70000" }));
    expect(request?.[2].timeoutMs).toBe(60000);
  });

  it("combines browser profile with browser start --headless", async () => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "--browser-profile", "work", "start", "--headless"], {
      from: "user",
    });

    const startCall = findBrowserManageCall("/start");
    expect(startCall?.[2].query).toEqual({ profile: "work", headless: "true" });
  });

  it.each(fixedBudgetRequests)("retains the built-in budget for $args", async ({ args, path }) => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "--json", ...args], { from: "user" });

    const timeoutMs = path === "/profiles/import" ? 120_000 : 45_000;
    const request = findBrowserManageCall(path);
    expect(request?.[2].timeoutMs).toBe(timeoutMs);
    expect(request?.[1].timeout).toBe(String(timeoutMs + 10_000));
  });

  it.each(fixedBudgetRequests)("honors the authored budget for $args", async ({ args, path }) => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "--timeout", "60000", "--json", ...args], {
      from: "user",
    });

    const request = findBrowserManageCall(path);
    expect(request?.[2].timeoutMs).toBe(60000);
    expect(request?.[1].timeout).toBe("70000");
  });

  it.each([
    { args: ["--timeout", "30000", "tabs"] },
    { args: ["tabs", "--timeout", "30000"] },
    { args: ["--timeout", "30000", "tab", "new"] },
    { args: ["tab", "--timeout", "30000", "new"] },
    { args: ["tab", "new", "--timeout", "30000"] },
  ])("distinguishes an authored default value in $args", async ({ args }) => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "--json", ...args], { from: "user" });

    const request = getBrowserManageGatewayMock().mock.calls.at(-1);
    expect(request?.[2].timeoutMs).toBe(30000);
    expect(request?.[1].timeout).toBe("40000");
  });

  it.each([
    { args: ["--timeout", "0", "tabs"] },
    { args: ["--timeout", "bogus", "tabs"] },
    { args: ["tabs", "--timeout", "0"] },
    { args: ["--timeout", "0", "tab", "new"] },
    { args: ["tab", "new", "--timeout", "bogus"] },
  ])("rejects invalid authored timeouts before dispatch in $args", async ({ args }) => {
    const program = createBrowserManageProgram({ withParentTimeout: true });

    await expect(program.parseAsync(["browser", ...args], { from: "user" })).rejects.toThrow(
      "--timeout must be a positive integer.",
    );
    expect(getBrowserManageGatewayMock()).not.toHaveBeenCalled();
  });

  it.each([
    { args: [], managementTimeoutMs: 45000 },
    { args: ["--timeout", "60000"], managementTimeoutMs: 60000 },
    { args: ["--timeout", "30000"], managementTimeoutMs: 30000 },
  ])("keeps the deep snapshot bounded with management timeout $args", async (scenario) => {
    getBrowserManageGatewayMock()
      .mockResolvedValueOnce({
        status: { enabled: true, running: true, profile: "work" },
        checks: [],
      })
      .mockResolvedValueOnce({ profiles: [] })
      .mockResolvedValueOnce({ tabs: [] })
      .mockResolvedValueOnce({
        state: "none",
        browser: "Google Chrome",
        version: "154.0.8037.97",
        os: "Linux",
        policies: {},
      })
      .mockResolvedValueOnce({ format: "aria", nodes: [{}] });
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "--json", ...scenario.args, "doctor", "--deep"], {
      from: "user",
    });

    for (const route of ["/doctor", "/profiles", "/tabs", "/policy", "/snapshot"]) {
      const request = findBrowserManageCall(route);
      const timeoutMs = route === "/snapshot" ? 10000 : scenario.managementTimeoutMs;
      expect(request?.[2].timeoutMs).toBe(timeoutMs);
      expect(request?.[1].timeout).toBe(String(timeoutMs + 10_000));
    }
  });

  it("honors the authored budget on both stop and its status readback", async () => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "--timeout", "60000", "stop"], { from: "user" });

    for (const route of ["/stop", "/"]) {
      const request = findBrowserManageCall(route);
      expect(request?.[2].timeoutMs).toBe(60000);
      expect(request?.[1].timeout).toBe("70000");
    }
  });
});
