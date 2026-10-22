import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "../config.js";
import { createVoiceCallBaseConfig } from "../test-fixtures.js";

const { runCommandMock } = vi.hoisted(() => ({ runCommandMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandWithTimeout: runCommandMock,
}));

import {
  cleanupTailscaleExposure,
  cleanupTailscaleExposureRoute,
  getTailscaleSelfInfo,
  setupTailscaleExposure,
  setupTailscaleExposureRoutes,
} from "./tailscale.js";

function commandResult(overrides: Record<string, unknown> = {}) {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

const dnsResult = () =>
  commandResult({
    stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }),
  });
const route = { path: "/voice", localUrl: "http://127.0.0.1:8787/webhook" };
const funnel8443 = ["tailscale", "funnel", "--bg", "--yes", "--https", "8443", "--set-path"];
function config(
  mode: VoiceCallConfig["tailscale"]["mode"],
  overrides: {
    [K in "tailscale" | "serve" | "realtime" | "streaming"]?: Partial<VoiceCallConfig[K]>;
  } = {},
) {
  const base = createVoiceCallBaseConfig();
  return {
    ...base,
    tailscale: { mode, port: 443, path: "/voice", ...overrides.tailscale },
    serve: { ...base.serve, port: 8787, path: "/webhook", ...overrides.serve },
    realtime: { ...base.realtime, ...overrides.realtime },
    streaming: { ...base.streaming, ...overrides.streaming },
  };
}
function mockRoutes() {
  runCommandMock.mockImplementation(async (command: string[]) =>
    command[1] === "status" ? dnsResult() : commandResult(),
  );
}

describe("voice-call tailscale helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCommandMock.mockResolvedValue(commandResult());
  });

  it("returns null for command, timeout, output-limit, and JSON failures", async () => {
    runCommandMock.mockResolvedValueOnce(commandResult({ code: 1, stdout: "bad" }));
    await expect(getTailscaleSelfInfo()).resolves.toBeNull();
    expect(runCommandMock).toHaveBeenCalledWith(
      ["tailscale", "status", "--json", "--peers=false"],
      expect.objectContaining({
        killProcessTree: true,
        maxOutputBytes: { stdout: 4 * 1024 * 1024, stderr: 1 },
        terminateOnOutputLimit: { stdout: true },
        timeoutMs: 2500,
      }),
    );

    runCommandMock.mockResolvedValueOnce(commandResult({ stdout: "{not-json" }));
    await expect(getTailscaleSelfInfo()).resolves.toBeNull();

    runCommandMock.mockRejectedValueOnce(new Error("tailscale missing"));
    await expect(getTailscaleSelfInfo()).resolves.toBeNull();

    runCommandMock.mockResolvedValueOnce(commandResult({ code: null, termination: "timeout" }));
    await expect(getTailscaleSelfInfo()).resolves.toBeNull();

    runCommandMock.mockResolvedValueOnce(
      commandResult({ code: null, termination: "signal", outputLimitExceeded: true }),
    );
    await expect(getTailscaleSelfInfo()).resolves.toBeNull();
  });

  it("sets up and cleans up exposure routes with the selected mode", async () => {
    runCommandMock.mockResolvedValueOnce(dnsResult());

    await expect(
      setupTailscaleExposureRoutes({
        mode: "serve",
        port: 443,
        routes: [route],
      }),
    ).resolves.toBe("https://bot.example.ts.net/voice");
    await cleanupTailscaleExposureRoute({ mode: "serve", port: 443, path: "/voice" });

    expect(runCommandMock).toHaveBeenNthCalledWith(
      2,
      ["tailscale", "serve", "--bg", "--yes", "--set-path", route.path, route.localUrl],
      expect.any(Object),
    );
    expect(runCommandMock).toHaveBeenNthCalledWith(
      3,
      ["tailscale", "serve", "off", "/voice"],
      expect.any(Object),
    );
  });

  it("returns null when setup cannot resolve dns or route activation fails", async () => {
    runCommandMock
      .mockResolvedValueOnce(commandResult({ code: 1 }))
      .mockResolvedValueOnce(dnsResult())
      .mockResolvedValueOnce(commandResult({ code: 1 }));

    const exposure = { mode: "funnel" as const, port: 443, routes: [route] };
    await expect(setupTailscaleExposureRoutes(exposure)).resolves.toBeNull();
    await expect(setupTailscaleExposureRoutes(exposure)).resolves.toBeNull();
  });

  it("maps config modes to serve or funnel and skips off", async () => {
    runCommandMock.mockResolvedValueOnce(dnsResult());

    await expect(setupTailscaleExposure(config("off"))).resolves.toBeNull();
    await expect(setupTailscaleExposure(config("funnel"))).resolves.toBe(
      "https://bot.example.ts.net/voice",
    );
    await cleanupTailscaleExposure(config("serve"));

    expect(runCommandMock.mock.calls[1]?.[0]).toEqual([
      "tailscale",
      "funnel",
      "--bg",
      "--yes",
      "--set-path",
      "/voice",
      "http://127.0.0.1:8787/webhook",
    ]);
    expect(runCommandMock.mock.calls[2]?.[0]).toEqual(["tailscale", "serve", "off", "/voice"]);
  });

  it("mounts and cleans up the enabled streaming stream path", async () => {
    mockRoutes();
    const voiceCallConfig = config("funnel", {
      tailscale: { mode: "funnel", port: 443, path: "/edge/voice/webhook" },
      serve: { port: 8787, path: "/voice/webhook" },
      streaming: { enabled: true, streamPath: "/voice/stream" },
    });

    await setupTailscaleExposure(voiceCallConfig);
    await cleanupTailscaleExposure(voiceCallConfig);

    expect(runCommandMock).toHaveBeenCalledWith(
      [
        "tailscale",
        "funnel",
        "--bg",
        "--yes",
        "--set-path",
        "/voice/stream",
        "http://127.0.0.1:8787/voice/stream",
      ],
      expect.any(Object),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      ["tailscale", "funnel", "off", "/voice/stream"],
      expect.any(Object),
    );
  });

  it("uses HTTPS 8443 for legacy webhook and realtime routes and cleanup", async () => {
    mockRoutes();
    const voiceCallConfig = config("funnel", {
      tailscale: { mode: "funnel", port: 8443, path: "/voice/webhook" },
      serve: { port: 8787, path: "/voice/webhook" },
      realtime: { enabled: true, streamPath: "/voice/stream/realtime" },
    });

    await expect(setupTailscaleExposure(voiceCallConfig)).resolves.toBe(
      "https://bot.example.ts.net:8443/voice/webhook",
    );
    await cleanupTailscaleExposure(voiceCallConfig);

    expect(runCommandMock.mock.calls.map(([command]) => command)).toEqual([
      ["tailscale", "status", "--json", "--peers=false"],
      [...funnel8443, "/voice/webhook", "http://127.0.0.1:8787/voice/webhook"],
      [...funnel8443, "/voice/stream/realtime", "http://127.0.0.1:8787/voice/stream/realtime"],
      [...funnel8443, "/voice/webhook", "off"],
      [...funnel8443, "/voice/stream/realtime", "off"],
    ]);
  });

  it("deduplicates equal realtime and streaming paths", async () => {
    mockRoutes();
    const voiceCallConfig = config("funnel", {
      tailscale: { mode: "funnel", port: 443, path: "/voice/webhook" },
      serve: { port: 8787, path: "/voice/webhook" },
      realtime: { enabled: true, streamPath: "/voice/stream" },
      streaming: { enabled: true, streamPath: "/voice/stream" },
    });

    await setupTailscaleExposure(voiceCallConfig);

    const streamMounts = runCommandMock.mock.calls.filter(
      ([command]) => command[5] === "/voice/stream",
    );
    expect(streamMounts).toHaveLength(1);
  });

  it("rolls back direct exposure when a stream route cannot be mounted", async () => {
    runCommandMock.mockImplementation(async (command: string[]) => {
      if (command[1] === "status") {
        return dnsResult();
      }
      if (command[1] === "funnel" && command[5] === "/voice/stream/realtime") {
        return commandResult({ code: 1 });
      }
      return commandResult();
    });
    const voiceCallConfig = config("funnel", {
      tailscale: { mode: "funnel", port: 443, path: "/voice/webhook" },
      serve: { port: 8787, path: "/voice/webhook" },
      realtime: { enabled: true, streamPath: "/voice/stream/realtime" },
    });

    await expect(setupTailscaleExposure(voiceCallConfig)).resolves.toBeNull();
    expect(runCommandMock).toHaveBeenCalledWith(
      ["tailscale", "funnel", "off", "/voice/webhook"],
      expect.any(Object),
    );
  });
});
