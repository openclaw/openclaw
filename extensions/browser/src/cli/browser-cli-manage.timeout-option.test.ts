import { beforeEach, describe, expect, it } from "vitest";
import {
  createBrowserManageProgram,
  findBrowserManageCall,
  getBrowserManageGatewayMock,
} from "./browser-cli-manage.test-helpers.js";
import { getBrowserCliRuntimeCapture } from "./browser-cli.test-support.js";

describe("browser manage start timeout option", () => {
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

  it("passes headless=true for browser start --headless", async () => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "start", "--headless"], { from: "user" });

    const startCall = findBrowserManageCall("/start");
    expect(startCall?.[2].query).toEqual({ headless: "true" });
  });

  it("combines browser profile with browser start --headless", async () => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "--browser-profile", "work", "start", "--headless"], {
      from: "user",
    });

    const startCall = findBrowserManageCall("/start");
    expect(startCall?.[2].query).toEqual({ profile: "work", headless: "true" });
  });

  it("uses a longer built-in timeout for browser status", async () => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "status"], { from: "user" });

    const statusCall = findBrowserManageCall("/");
    expect(statusCall?.[2].timeoutMs).toBe(45_000);
  });

  it("uses a longer built-in timeout for browser tabs", async () => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "tabs"], { from: "user" });

    const tabsCall = findBrowserManageCall("/tabs");
    expect(tabsCall?.[2].timeoutMs).toBe(45_000);
  });

  it("uses a longer built-in timeout for browser profiles", async () => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "profiles"], { from: "user" });

    const profilesCall = findBrowserManageCall("/profiles");
    expect(profilesCall?.[2].timeoutMs).toBe(45_000);
  });

  it("uses a longer built-in timeout for browser open", async () => {
    const program = createBrowserManageProgram({ withParentTimeout: true });
    await program.parseAsync(["browser", "open", "https://example.com"], { from: "user" });

    const openCall = findBrowserManageCall("/tabs/open");
    expect(openCall?.[2].timeoutMs).toBe(45_000);
  });
});
