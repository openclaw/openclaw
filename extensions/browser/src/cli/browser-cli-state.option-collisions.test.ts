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

  const getLastRequest = () => {
    const call = gatewayMock.mock.calls.at(-1);
    if (!call) {
      throw new Error("expected browser request call");
    }
    return call[2];
  };

  const runBrowserCommand = async (argv: string[]) => {
    const program = createStateProgram();
    await program.parseAsync(["browser", ...argv], { from: "user" });
  };

  const runBrowserCommandAndGetRequest = async (argv: string[]) => {
    await runBrowserCommand(argv);
    return getLastRequest();
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
    { args: ["cookies"], path: "/cookies" },
    {
      args: ["cookies", "set", "session", "value", "--url", "https://example.com"],
      path: "/cookies/set",
    },
    { args: ["cookies", "clear"], path: "/cookies/clear" },
    { args: ["storage", "local", "get"], path: "/storage/local" },
    { args: ["storage", "local", "set", "key", "value"], path: "/storage/local/set" },
    { args: ["storage", "local", "clear"], path: "/storage/local/clear" },
    { args: ["storage", "session", "get"], path: "/storage/session" },
    { args: ["storage", "session", "set", "key", "value"], path: "/storage/session/set" },
    { args: ["storage", "session", "clear"], path: "/storage/session/clear" },
    { args: ["set", "offline", "on"], path: "/set/offline" },
    { args: ["set", "headers", "{}"], path: "/set/headers" },
    { args: ["set", "credentials", "name", "value"], path: "/set/credentials" },
    { args: ["set", "geo", "48", "16"], path: "/set/geolocation" },
    { args: ["set", "media", "dark"], path: "/set/media" },
    { args: ["set", "timezone", "UTC"], path: "/set/timezone" },
    { args: ["set", "locale", "en-US"], path: "/set/locale" },
    { args: ["set", "device", "iPhone 14"], path: "/set/device" },
  ])("inherits parent timeout for $path", async ({ args, path }) => {
    await runBrowserCommand(["--timeout", "60000", "--json", ...args]);

    expect(gatewayMock).toHaveBeenLastCalledWith(
      "browser.request",
      expect.objectContaining({ timeout: "70000" }),
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

    await runBrowserCommand(["storage", "local", "get", " account "]);

    const { runtimeLogs } = getBrowserCliRuntimeCapture();
    expect(runtimeLogs.map((line) => JSON.parse(line))).toEqual([{ " account ": "padded" }]);
  });

  it("inherits the parent timeout and profile and normalizes the viewport alias target", async () => {
    await runBrowserCommand([
      "--timeout",
      "60000",
      "--browser-profile",
      "work",
      "--json",
      "set",
      "viewport",
      "1024",
      "768",
      "--target-id",
      " tab-1 ",
    ]);

    expect(gatewayMock).toHaveBeenLastCalledWith(
      "browser.request",
      expect.objectContaining({ timeout: "70000" }),
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
    const request = await runBrowserCommandAndGetRequest([
      "cookies",
      "set",
      "session",
      "abc",
      "--url",
      "https://example.com",
      "--target-id",
      "tab-1",
    ]);

    expect(request.body?.targetId).toBe("tab-1");
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

  it("accepts legacy parent `--json` by parsing payload via positional headers fallback", async () => {
    const request = await runBrowserCommandAndGetRequest([
      "set",
      "headers",
      "--json",
      '{"x-auth":"ok"}',
    ]);
    expect(request.body?.headers).toEqual({ "x-auth": "ok" });
  });

  it("filters non-string header values from JSON payload", async () => {
    const request = await runBrowserCommandAndGetRequest([
      "set",
      "headers",
      "--json",
      '{"x-auth":"ok","retry":3,"enabled":true}',
    ]);
    expect(request.body?.headers).toEqual({ "x-auth": "ok" });
  });

  it("errors when set offline receives an invalid value", async () => {
    await runBrowserCommand(["set", "offline", "maybe"]);

    expect(gatewayMock).not.toHaveBeenCalled();
    expectErrorMessage("Expected on|off");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });

  it("rejects non-decimal viewport dimensions before resize dispatch", async () => {
    await runBrowserCommand(["set", "viewport", "1e3", "768"]);

    expect(gatewayMock).not.toHaveBeenCalled();
    expectErrorMessage("Invalid width: must be a positive integer");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });

  it("rejects excessive viewport dimensions before resize dispatch", async () => {
    await runBrowserCommand(["set", "viewport", "8193", "768"]);

    expect(gatewayMock).not.toHaveBeenCalled();
    expectErrorMessage("Invalid width: maximum is 8192");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });

  it("errors when set media receives an invalid value", async () => {
    await runBrowserCommand(["set", "media", "sepia"]);

    expect(gatewayMock).not.toHaveBeenCalled();
    expectErrorMessage("Expected dark|light|no-preference|none");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });

  it("passes no-preference through to /set/media", async () => {
    const request = await runBrowserCommandAndGetRequest(["set", "media", "no-preference"]);

    expect(request.body).toMatchObject({ colorScheme: "no-preference" });
  });

  it("rejects invalid geolocation numbers before dispatch", async () => {
    await runBrowserCommand(["set", "geo", "48.208", "16.373", "--accuracy", "fast"]);

    expect(gatewayMock).not.toHaveBeenCalled();
    expectErrorMessage("Invalid --accuracy: must be a finite number");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });

  it("passes valid decimal geolocation numbers", async () => {
    const request = await runBrowserCommandAndGetRequest([
      "set",
      "geo",
      "48.2082",
      "16.3738",
      "--accuracy",
      "12.5",
    ]);

    expect(request.body).toMatchObject({
      latitude: 48.2082,
      longitude: 16.3738,
      accuracy: 12.5,
    });
  });

  it("errors when headers JSON is missing", async () => {
    await runBrowserCommand(["set", "headers"]);

    expect(gatewayMock).not.toHaveBeenCalled();
    expectErrorMessage(
      "Error: Missing headers JSON (pass --headers-json or positional JSON argument)",
    );
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });

  it("errors when headers JSON is not an object", async () => {
    await runBrowserCommand(["set", "headers", "--json", "[]"]);

    expect(gatewayMock).not.toHaveBeenCalled();
    expectErrorMessage("Error: Headers JSON must be a JSON object");
    expect(getBrowserCliRuntime().exit).toHaveBeenCalledWith(1);
  });
});
