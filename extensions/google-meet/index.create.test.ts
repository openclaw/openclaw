import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.ts";
import plugin from "./index.js";
import { registerGoogleMeetCli } from "./src/cli.js";
import { resolveGoogleMeetConfig } from "./src/config.js";
import type { GoogleMeetRuntime } from "./src/runtime.js";
import { CREATE_MEET_FROM_BROWSER_SCRIPT } from "./src/transports/chrome-create.js";

const voiceCallMocks = vi.hoisted(() => ({
  joinMeetViaVoiceCallGateway: vi.fn(async () => ({ callId: "call-1", dtmfSent: true })),
  endMeetVoiceCallGatewayCall: vi.fn(async () => {}),
}));

const fetchGuardMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(
    async (params: {
      url: string;
      init?: RequestInit;
    }): Promise<{
      response: Response;
      release: () => Promise<void>;
    }> => ({
      response: await fetch(params.url, params.init),
      release: vi.fn(async () => {}),
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchGuardMocks.fetchWithSsrFGuard,
}));

vi.mock("./src/voice-call-gateway.js", () => ({
  joinMeetViaVoiceCallGateway: voiceCallMocks.joinMeetViaVoiceCallGateway,
  endMeetVoiceCallGatewayCall: voiceCallMocks.endMeetVoiceCallGatewayCall,
}));

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function captureStdout() {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return {
    output: () => output,
    restore: () => writeSpy.mockRestore(),
  };
}

async function runCreateMeetBrowserScript(params: { buttonText: string }) {
  const location = {
    href: "https://meet.google.com/new",
    hostname: "meet.google.com",
  };
  const button = {
    disabled: false,
    innerText: params.buttonText,
    textContent: params.buttonText,
    getAttribute: (name: string) => (name === "aria-label" ? params.buttonText : null),
    click: vi.fn(() => {
      location.href = "https://meet.google.com/abc-defg-hij";
    }),
  };
  const document = {
    title: "Meet",
    body: {
      innerText: "Do you want people to hear you in the meeting?",
      textContent: "Do you want people to hear you in the meeting?",
    },
    querySelectorAll: (selector: string) => (selector === "button" ? [button] : []),
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("location", location);
  const fn = (0, eval)(`(${CREATE_MEET_FROM_BROWSER_SCRIPT})`) as () => Promise<{
    meetingUri?: string;
    manualActionReason?: string;
    notes?: string[];
    retryAfterMs?: number;
  }>;
  return { button, result: await fn() };
}

function setup(
  config: Record<string, unknown> = {},
  options: {
    nodesInvokeHandler?: (params: {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
    }) => Promise<unknown>;
  } = {},
) {
  const methods = new Map<string, unknown>();
  const tools: unknown[] = [];
  const nodesList = vi.fn(async () => ({
    nodes: [
      {
        nodeId: "node-1",
        displayName: "parallels-macos",
        connected: true,
        caps: ["browser"],
        commands: ["browser.proxy", "googlemeet.chrome"],
      },
    ],
  }));
  const nodesInvoke = vi.fn(async (params) => {
    if (options.nodesInvokeHandler) {
      return options.nodesInvokeHandler(params);
    }
    if (params.command === "browser.proxy") {
      const proxy = params.params as { path?: string; body?: { url?: string; targetId?: string } };
      if (proxy.path === "/tabs") {
        return { payload: { result: { running: true, tabs: [] } } };
      }
      if (proxy.path === "/tabs/open") {
        return {
          payload: {
            result: {
              targetId: "tab-1",
              title: "Meet",
              url: proxy.body?.url ?? "https://meet.google.com/abc-defg-hij",
            },
          },
        };
      }
      return { payload: { result: { ok: true } } };
    }
    return { payload: { launched: true } };
  });
  const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
    if (argv[0] === "/usr/sbin/system_profiler") {
      return { code: 0, stdout: "BlackHole 2ch", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const api = createTestPluginApi({
    id: "google-meet",
    name: "Google Meet",
    description: "test",
    version: "0",
    source: "test",
    config: {},
    pluginConfig: config,
    runtime: {
      system: {
        runCommandWithTimeout,
        formatNativeDependencyHint: vi.fn(() => "Install with brew install blackhole-2ch."),
      },
      nodes: {
        list: nodesList,
        invoke: nodesInvoke,
      },
    } as unknown as OpenClawPluginApi["runtime"],
    logger: noopLogger,
    registerGatewayMethod: (method: string, handler: unknown) => methods.set(method, handler),
    registerTool: (tool: unknown) => tools.push(tool),
  });
  plugin.register(api);
  return {
    methods,
    tools,
    nodesInvoke,
  };
}

describe("google-meet create flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("CLI create prints the new meeting URL", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({
            access_token: "new-access-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          name: "spaces/new-space",
          meetingCode: "new-abcd-xyz",
          meetingUri: "https://meet.google.com/new-abcd-xyz",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const program = new Command();
    const stdout = captureStdout();
    registerGoogleMeetCli({
      program,
      config: resolveGoogleMeetConfig({
        oauth: { clientId: "client-id", refreshToken: "refresh-token" },
      }),
      ensureRuntime: async () => ({}) as GoogleMeetRuntime,
    });

    try {
      await program.parseAsync(["googlemeet", "create", "--no-join"], { from: "user" });
      expect(stdout.output()).toContain("meeting uri: https://meet.google.com/new-abcd-xyz");
      expect(stdout.output()).toContain("space: spaces/new-space");
    } finally {
      stdout.restore();
    }
  });

  it("can create a Meet through browser fallback without joining when requested", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesInvokeHandler: async (params) => {
          const proxy = params.params as { path?: string; body?: { url?: string } };
          if (proxy.path === "/tabs") {
            return { payload: { result: { tabs: [] } } };
          }
          if (proxy.path === "/tabs/open") {
            return {
              payload: {
                result: {
                  targetId: "tab-1",
                  title: "Meet",
                  url: proxy.body?.url,
                },
              },
            };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  ok: true,
                  targetId: "tab-1",
                  result: {
                    meetingUri: "https://meet.google.com/browser-made-url",
                    browserUrl: "https://meet.google.com/browser-made-url",
                    browserTitle: "Meet",
                  },
                },
              },
            };
          }
          return { payload: { result: { ok: true } } };
        },
      },
    );
    const handler = methods.get("googlemeet.create") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: { join: false }, respond });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      source: "browser",
      meetingUri: "https://meet.google.com/browser-made-url",
      joined: false,
      browser: { nodeId: "node-1", targetId: "tab-1" },
    });
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "browser.proxy",
        params: expect.objectContaining({
          path: "/tabs/open",
          body: { url: "https://meet.google.com/new" },
        }),
      }),
    );
  });

  it("creates and joins a Meet through the create tool action by default", async () => {
    const { tools, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesInvokeHandler: async (params) => {
          if (params.command === "googlemeet.chrome") {
            return { payload: { launched: true } };
          }
          const proxy = params.params as {
            path?: string;
            body?: { url?: string; targetId?: string; fn?: string };
          };
          if (proxy.path === "/tabs") {
            return { payload: { result: { tabs: [] } } };
          }
          if (proxy.path === "/tabs/open") {
            return {
              payload: {
                result: {
                  targetId:
                    proxy.body?.url === "https://meet.google.com/new" ? "create-tab" : "join-tab",
                  title: "Meet",
                  url: proxy.body?.url,
                },
              },
            };
          }
          if (proxy.path === "/act" && proxy.body?.fn?.includes("meetUrlPattern")) {
            return {
              payload: {
                result: {
                  ok: true,
                  targetId: "create-tab",
                  result: {
                    meetingUri: "https://meet.google.com/new-abcd-xyz",
                    browserUrl: "https://meet.google.com/new-abcd-xyz",
                    browserTitle: "Meet",
                  },
                },
              },
            };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  ok: true,
                  targetId: "join-tab",
                  result: JSON.stringify({
                    inCall: true,
                    micMuted: false,
                    title: "Meet call",
                    url: "https://meet.google.com/new-abcd-xyz",
                  }),
                },
              },
            };
          }
          return { payload: { result: { ok: true } } };
        },
      },
    );
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{
        details: { joined?: boolean; meetingUri?: string; join?: { session: { url: string } } };
      }>;
    };

    const result = await tool.execute("id", { action: "create" });

    expect(result.details).toMatchObject({
      source: "browser",
      joined: true,
      meetingUri: "https://meet.google.com/new-abcd-xyz",
      join: { session: { url: "https://meet.google.com/new-abcd-xyz" } },
    });
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "googlemeet.chrome",
        params: expect.objectContaining({
          action: "start",
          url: "https://meet.google.com/new-abcd-xyz",
          launch: false,
        }),
      }),
    );
  });

  it("reuses an existing browser create tab instead of opening duplicates", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesInvokeHandler: async (params) => {
          const proxy = params.params as { path?: string; body?: { targetId?: string } };
          if (proxy.path === "/tabs") {
            return {
              payload: {
                result: {
                  tabs: [
                    {
                      targetId: "existing-create-tab",
                      title: "Meet",
                      url: "https://meet.google.com/new",
                    },
                  ],
                },
              },
            };
          }
          if (proxy.path === "/tabs/focus") {
            return { payload: { result: { ok: true } } };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  ok: true,
                  targetId: proxy.body?.targetId ?? "existing-create-tab",
                  result: {
                    meetingUri: "https://meet.google.com/reu-sedx-tab",
                    browserUrl: "https://meet.google.com/reu-sedx-tab",
                    browserTitle: "Meet",
                  },
                },
              },
            };
          }
          throw new Error(`unexpected browser proxy path ${proxy.path}`);
        },
      },
    );
    const handler = methods.get("googlemeet.create") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({ params: { join: false }, respond });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      source: "browser",
      meetingUri: "https://meet.google.com/reu-sedx-tab",
      browser: { nodeId: "node-1", targetId: "existing-create-tab" },
    });
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          path: "/tabs/focus",
          body: { targetId: "existing-create-tab" },
        }),
      }),
    );
    expect(nodesInvoke).not.toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ path: "/tabs/open" }),
      }),
    );
  });

  it.each([
    ["Use microphone", "Accepted Meet microphone prompt with browser automation."],
    [
      "Continue without microphone",
      "Continued through Meet microphone prompt with browser automation.",
    ],
  ])(
    "uses browser automation for Meet's %s choice during browser creation",
    async (buttonText, note) => {
      const { button, result } = await runCreateMeetBrowserScript({ buttonText });

      expect(result).toMatchObject({
        retryAfterMs: 1000,
        notes: [note],
      });
      expect(button.click).toHaveBeenCalledTimes(1);
      expect(result.meetingUri).toBeUndefined();
      expect(result.manualActionReason).toBeUndefined();
    },
  );
});
