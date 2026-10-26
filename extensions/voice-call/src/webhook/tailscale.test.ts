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

  it.each([
    ["serve", 443, false, false],
    ["funnel", 443, false, false],
    ["funnel", 443, false, true],
    ["funnel", 443, true, true],
    ["funnel", 8443, true, false],
  ] as const)(
    "mounts and cleans up %s:%d realtime=%s streaming=%s",
    async (mode, port, realtime, streaming) => {
      mockRoutes();
      const cfg = config(mode, port, realtime);
      if (streaming) {
        cfg.tailscale.path = "/edge/voice/webhook";
        cfg.serve.path = "/voice/webhook";
        cfg.realtime.streamPath = "/voice/stream";
      }
      cfg.streaming.enabled = streaming;
      const paths: Array<[string, string]> = [[cfg.tailscale.path, cfg.serve.path]];
      if (streaming || realtime) {
        const streamPath = streaming ? "/voice/stream" : "/voice/stream/realtime";
        paths.push([streamPath, streamPath]);
      }
      const prefix = ["tailscale", mode, "--bg", "--yes"];
      if (port === 8443) {
        prefix.push("--https", "8443");
      }
      prefix.push("--set-path");
      await expect(setupTailscaleExposure(cfg)).resolves.toBe(
        `https://bot.example.ts.net${port === 443 ? "" : ":8443"}${cfg.tailscale.path}`,
      );
      await cleanupTailscaleExposure(cfg);
      const expected = [["tailscale", "status", "--json", "--peers=false"]];
      for (const [publicPath, localPath] of paths) {
        expected.push([...prefix, publicPath, `http://127.0.0.1:8787${localPath}`]);
      }
      for (const [publicPath] of paths) {
        expected.push(
          port === 443 ? ["tailscale", mode, "off", publicPath] : [...prefix, publicPath, "off"],
        );
      }
      expect(commands()).toEqual(expected);
    },
  );

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
