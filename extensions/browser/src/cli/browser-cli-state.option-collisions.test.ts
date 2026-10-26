import { beforeEach, describe, expect, it } from "vitest";
import { mockBrowserGateway } from "./browser-cli.test-support.js";

const gatewayMock = mockBrowserGateway();
const {
  createBrowserProgram: createBrowserProgramShared,
  getBrowserCliRuntime,
  mockBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} = await import("./browser-cli.test-support.js");
mockBrowserCliRuntime();

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
    await expect(
      program.parseAsync(
        ["browser", "--url", "wss://gateway.example.com", "cookies", "set", "session", "abc"],
        { from: "user" },
      ),
    ).rejects.toThrow("Missing required --url option for cookies set");

    expect(gatewayMock).not.toHaveBeenCalled();
    expect(getBrowserCliRuntime().exit).not.toHaveBeenCalled();
  });

  it.each([
    ['{"x-auth":"ok","retry":3,"enabled":true}', { "x-auth": "ok" }],
    ['{"retry":3,"enabled":true}', {}],
    ['{"__proto__":"ignored","x-auth":"ok"}', { "x-auth": "ok" }],
  ])("filters non-string and prototype header values from %s", async (input, expected) => {
    const request = await run("set headers --json", input);
    expect(request?.body?.headers).toEqual(expected);
  });

  it("passes no-preference through to /set/media", async () => {
    expect((await run("set media no-preference"))?.body).toMatchObject({
      colorScheme: "no-preference",
    });
  });

  it.each([
    ["set viewport 1e3 768", "Invalid width: must be a positive integer"],
    ["set media sepia", "Expected dark|light|no-preference|none"],
    ["set geo 48 16 --accuracy fast", "Invalid --accuracy: must be a finite number"],
    ["cookies set session abc", "Missing required --url option for cookies set"],
  ])("passes JSON refusal for %s to the host renderer", async (command, message) => {
    const program = createStateProgram();
    await expect(
      program.parseAsync(["browser", "--json", ...command.split(" ")], { from: "user" }),
    ).rejects.toThrow(message);
    expect(gatewayMock).not.toHaveBeenCalled();
    expect(getBrowserCliRuntime().exit).not.toHaveBeenCalled();
    expect(getBrowserCliRuntime().error).not.toHaveBeenCalled();
  });

  it.each([
    ["set viewport 8193 768", "Invalid width: maximum is 8192"],
    ["set viewport 1024 0", "Invalid height: must be a positive integer"],
    ["set offline sometimes", "Expected on|off"],
    ["set geo 0x10 16", "Invalid latitude: must be a finite number"],
    ["set geo 48 NaN", "Invalid longitude: must be a finite number"],
  ])("rejects %s before dispatch", async (command, message) => {
    await expect(run(command)).rejects.toThrow(message);
    expect(gatewayMock).not.toHaveBeenCalled();
  });

  it.each([
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
