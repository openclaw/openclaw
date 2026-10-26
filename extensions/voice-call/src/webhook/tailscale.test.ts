import { beforeEach, expect, it, vi } from "vitest";
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

const dnsResult = () => commandResult({ stdout: '{"Self":{"DNSName":"bot.example.ts.net."}}' });
const route = { path: "/voice", localUrl: "http://127.0.0.1:8787/webhook" };
function config(mode: VoiceCallConfig["tailscale"]["mode"], port = 443, realtime = false) {
  const base = createVoiceCallBaseConfig();
  base.tailscale = { mode, port, path: realtime ? "/voice/webhook" : "/voice" };
  Object.assign(base.serve, { port: 8787, path: realtime ? "/voice/webhook" : "/webhook" });
  base.realtime.enabled = realtime;
  return base;
}
const commands = () => runCommandMock.mock.calls.map(([command]) => command);
const expectCommand = (command: string[]) => expect(commands()).toContainEqual(command);

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
});

it.each([
  ["serve", 443, false],
  ["funnel", 8443, true],
] as const)("mounts and cleans up %s:%d realtime=%s", async (mode, port, realtime) => {
  runCommandMock.mockResolvedValueOnce(dnsResult());
  const cfg = config(mode, port, realtime);
  const paths: Array<[string, string]> = [[cfg.tailscale.path, cfg.serve.path]];
  if (realtime) {
    paths.push(["/voice/stream/realtime", "/voice/stream/realtime"]);
  }
  const prefix = ["tailscale", mode, "--bg", "--yes"]
    .concat(port === 443 ? [] : ["--https", "8443"])
    .concat("--set-path");
  await expect(setupTailscaleExposure(cfg)).resolves.toBe(
    `https://bot.example.ts.net${port === 443 ? "" : ":8443"}${cfg.tailscale.path}`,
  );
  await cleanupTailscaleExposure(cfg);
  expect(commands()).toEqual([
    ["tailscale", "status", "--json", "--peers=false"],
    ...paths.map(([path, local]) => prefix.concat(path, `http://127.0.0.1:8787${local}`)),
    ...paths.map(([path]) =>
      port === 443 ? ["tailscale", mode, "off", path] : prefix.concat(path, "off"),
    ),
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

it("rolls back direct exposure when a stream route cannot be mounted", async () => {
  runCommandMock
    .mockResolvedValueOnce(dnsResult())
    .mockResolvedValueOnce(commandResult())
    .mockResolvedValueOnce(commandResult({ code: 1 }));
  const voiceCallConfig = config("funnel", 443, true);

  await expect(setupTailscaleExposure(voiceCallConfig)).resolves.toBeNull();
  expectCommand(["tailscale", "funnel", "off", "/voice/webhook"]);
});
