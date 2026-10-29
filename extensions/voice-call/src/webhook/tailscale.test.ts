import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "../config.js";
import { createVoiceCallBaseConfig } from "../test-fixtures.js";

const { runCommandMock } = vi.hoisted(() => ({ runCommandMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandWithTimeout: runCommandMock,
}));

import { commandResult } from "../../../test-support/command-result.test-support.js";
import {
  cleanupTailscaleExposure,
  getTailscaleSelfInfo,
  setupTailscaleExposure,
  setupTailscaleExposureRoutes,
} from "./tailscale.js";

const dnsResult = () =>
  commandResult({
    stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }),
  });
const route = { path: "/voice", localUrl: "http://127.0.0.1:8787/webhook" };
const funnel = ["tailscale", "funnel", "--bg", "--yes", "--set-path"];
const funnel8443 = ["tailscale", "funnel", "--bg", "--yes", "--https", "8443", "--set-path"];
function config(mode: VoiceCallConfig["tailscale"]["mode"], port = 443, realtime = false) {
  const base = createVoiceCallBaseConfig();
  base.tailscale = { mode, port, path: realtime ? "/voice/webhook" : "/voice" };
  Object.assign(base.serve, { port: 8787, path: realtime ? "/voice/webhook" : "/webhook" });
  base.realtime.enabled = realtime;
  return base;
}
function mockRoutes() {
  runCommandMock.mockImplementation(async (command: string[]) =>
    command[1] === "status" ? dnsResult() : commandResult(),
  );
}
const commands = () => runCommandMock.mock.calls.map(([command]) => command);
const expectCommand = (command: string[]) => expect(commands()).toContainEqual(command);

describe("voice-call tailscale helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCommandMock.mockResolvedValue(commandResult());
  });

  it("returns null for command, timeout, output-limit, and JSON failures", async () => {
    for (const result of [
      { code: 1, stdout: "bad" },
      { stdout: "{not-json" },
      { code: null, termination: "timeout" },
      { code: null, termination: "signal", outputLimitExceeded: true },
    ] as const) {
      runCommandMock.mockResolvedValueOnce(commandResult(result));
      await expect(getTailscaleSelfInfo()).resolves.toBeNull();
    }
    runCommandMock.mockRejectedValueOnce(new Error("tailscale missing"));
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
  });

  it.each(["serve", "funnel"] as const)("sets up and cleans up %s exposure", async (mode) => {
    runCommandMock.mockResolvedValueOnce(dnsResult());
    await expect(setupTailscaleExposure(config(mode))).resolves.toBe(
      "https://bot.example.ts.net/voice",
    );
    await cleanupTailscaleExposure(config(mode));
    expect(commands().slice(1)).toEqual([
      ["tailscale", mode, "--bg", "--yes", "--set-path", route.path, route.localUrl],
      ["tailscale", mode, "off", route.path],
    ]);
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

  it("skips disabled exposure", async () => {
    await expect(setupTailscaleExposure(config("off"))).resolves.toBeNull();
    await cleanupTailscaleExposure(config("off"));
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("mounts and cleans up streaming once (realtime=%s)", async (enabled) => {
    mockRoutes();
    const voiceCallConfig = config("funnel");
    voiceCallConfig.tailscale.path = "/edge/voice/webhook";
    voiceCallConfig.serve.path = "/voice/webhook";
    Object.assign(voiceCallConfig.realtime, { enabled, streamPath: "/voice/stream" });
    voiceCallConfig.streaming.enabled = true;

    await setupTailscaleExposure(voiceCallConfig);
    await cleanupTailscaleExposure(voiceCallConfig);

    expectCommand([...funnel, "/voice/stream", "http://127.0.0.1:8787/voice/stream"]);
    expectCommand(["tailscale", "funnel", "off", "/voice/stream"]);
    expect(commands().filter((command) => command[5] === "/voice/stream")).toHaveLength(1);
  });

  it("uses HTTPS 8443 for legacy webhook and realtime routes and cleanup", async () => {
    mockRoutes();
    const voiceCallConfig = config("funnel", 8443, true);

    await expect(setupTailscaleExposure(voiceCallConfig)).resolves.toBe(
      "https://bot.example.ts.net:8443/voice/webhook",
    );
    await cleanupTailscaleExposure(voiceCallConfig);

    expect(commands()).toEqual([
      ["tailscale", "status", "--json", "--peers=false"],
      [...funnel8443, "/voice/webhook", "http://127.0.0.1:8787/voice/webhook"],
      [...funnel8443, "/voice/stream/realtime", "http://127.0.0.1:8787/voice/stream/realtime"],
      [...funnel8443, "/voice/webhook", "off"],
      [...funnel8443, "/voice/stream/realtime", "off"],
    ]);
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
    const voiceCallConfig = config("funnel", 443, true);

    await expect(setupTailscaleExposure(voiceCallConfig)).resolves.toBeNull();
    expectCommand(["tailscale", "funnel", "off", "/voice/webhook"]);
  });
});
