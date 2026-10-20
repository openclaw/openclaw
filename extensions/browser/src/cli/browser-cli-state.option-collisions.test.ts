import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockBrowserGateway } from "./browser-cli.test-support.js";

const gatewayMock = mockBrowserGateway();
const {
  createBrowserProgram: createBrowserProgramShared,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} = await import("./browser-cli.test-support.js");
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(defaultRuntime, "writeJson").mockImplementation(browserCliRuntime.writeJson);
vi.spyOn(defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserStateCommands } = await import("./browser-cli-state.js");

describe("browser state option collisions", () => {
  const ansiPattern = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
  const stripAnsi = (value: string) => value.replace(ansiPattern, "");

  const createStateProgram = ({ withGatewayUrl = false } = {}) => {
    const { program, browser, parentOpts } = createBrowserProgramShared({ withGatewayUrl });
    browser.option("--timeout <ms>", "Timeout in ms", "30000");
    registerBrowserStateCommands(browser, parentOpts);
    return program;
  };

  const run = async (command: string, ...literalArgs: string[]) => {
    const program = createStateProgram();
    await program.parseAsync(["browser", ...command.split(" "), ...literalArgs], { from: "user" });
    return gatewayMock.mock.calls.at(-1)?.[2];
  };

  const expectErrorMessage = (expected: string) => {
    const calls = getBrowserCliRuntime().error.mock.calls;
    const lastCall = calls.at(-1);
    expect(lastCall).toHaveLength(1);
    expect(stripAnsi(String(lastCall?.[0]))).toBe(expected);
  };

  beforeEach(() => {
    gatewayMock.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
    getBrowserCliRuntime().exit.mockImplementation(() => {});
  });

  it.each([
    { args: "cookies", path: "/cookies" },
    { args: "cookies clear", path: "/cookies/clear" },
    { args: "storage session set key value", path: "/storage/session/set" },
    { args: "storage session clear", path: "/storage/session/clear" },
    { args: "set offline on", path: "/set/offline" },
    { args: "set credentials name value", path: "/set/credentials" },
    { args: "set geo 48 16", path: "/set/geolocation" },
    { args: "set timezone UTC", path: "/set/timezone" },
  ])("inherits parent timeout for $path", async ({ args, path }) => {
    await run(`--timeout 60000 --json ${args}`);

    expect(gatewayMock).toHaveBeenLastCalledWith(
      "browser.request",
      expect.objectContaining({ timeout: "190000" }),
      expect.objectContaining({ path, timeoutMs: 60000 }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("reads the exact quoted storage key", async () => {
    const entries = [
      ["account", "plain"],
      [" account ", "padded"],
    ];
    gatewayMock.mockImplementationOnce(async (_method, _opts, request) => ({
      values: Object.fromEntries(
        entries.filter(([key]) => request.query?.key === undefined || key === request.query.key),
      ),
    }));

    await run("storage local get", " account ");

    const { runtimeLogs } = getBrowserCliRuntimeCapture();
    expect(runtimeLogs.map((line) => JSON.parse(line))).toEqual([{ " account ": "padded" }]);
  });

  it("inherits the parent timeout and profile and normalizes the viewport alias target", async () => {
    await run(
      "--timeout 60000 --browser-profile work --json set viewport 1024 768 --target-id",
      " tab-1 ",
    );

    expect(gatewayMock).toHaveBeenLastCalledWith(
      "browser.request",
      expect.objectContaining({ timeout: "190000" }),
      expect.objectContaining({
        path: "/act",
        query: { profile: "work" },
        body: { kind: "resize", width: 1024, height: 768, targetId: "tab-1" },
        timeoutMs: 60000,
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("forwards parent-captured --target-id on `browser cookies set`", async () => {
    const request = await run(
      "cookies set session abc --url https://example.com --target-id tab-1",
    );
    expect(request?.body?.targetId).toBe("tab-1");
  });

  it("does not inherit the parent Gateway URL as the cookie scope", async () => {
    const program = createStateProgram({ withGatewayUrl: true });
    await program.parseAsync(
      ["browser", "--url", "wss://gateway.example.com", "cookies", "set", "session", "abc"],
      { from: "user" },
    );

    expect(gatewayMock).not.toHaveBeenCalled();
    expectErrorMessage("Missing required --url option for cookies set");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });

  it("filters non-string header values from JSON payload", async () => {
    const request = await run("set headers --json", '{"x-auth":"ok","retry":3,"enabled":true}');
    expect(request?.body?.headers).toEqual({ "x-auth": "ok" });
  });

  it("passes no-preference through to /set/media", async () => {
    expect((await run("set media no-preference"))?.body).toMatchObject({
      colorScheme: "no-preference",
    });
  });

  it.each([
    ["set viewport 1e3 768", "Invalid width: must be a positive integer"],
    ["set viewport 8193 768", "Invalid width: maximum is 8192"],
    ["set media sepia", "Expected dark|light|no-preference|none"],
    ["set geo 48.208 16.373 --accuracy fast", "Invalid --accuracy: must be a finite number"],
    [
      "set headers",
      "Error: Missing headers JSON (pass --headers-json or positional JSON argument)",
    ],
    ["set headers --json []", "Error: Headers JSON must be a JSON object"],
  ])("rejects %s before dispatch", async (command, message) => {
    await run(command);
    expect(gatewayMock).not.toHaveBeenCalled();
    expectErrorMessage(message);
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });
});
