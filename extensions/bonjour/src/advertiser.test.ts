import fs from "node:fs";
import os from "node:os";
import type { CiaoLogger, ServiceOptions } from "@homebridge/ciao/native.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PublishedService = Required<
  Pick<ServiceOptions, "name" | "type" | "domain" | "hostname" | "port">
> & { txt: Record<string, string> };

const {
  createService,
  getResponder,
  shutdown,
  registerUncaughtExceptionHandler,
  registerUnhandledRejectionHandler,
  logger,
} = vi.hoisted(() => ({
  createService: vi.fn<(options: PublishedService) => unknown>(),
  getResponder: vi.fn<(options?: { logger?: CiaoLogger }) => unknown>(),
  shutdown: vi.fn(),
  registerUncaughtExceptionHandler: vi.fn(),
  registerUnhandledRejectionHandler: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function expectWarnContaining(fragment: string) {
  expect(warnMessages()).toContain(fragment);
}
const warnMessages = () => logger.warn.mock.calls.map(([message]) => String(message)).join("\n");

function expectCalledOnce(...functions: ReturnType<typeof vi.fn>[]) {
  for (const fn of functions) {
    expect(fn).toHaveBeenCalledTimes(1);
  }
}

function mockCiaoService() {
  const listeners = new Map<string, (value: unknown) => void>();
  const service = {
    listeners,
    advertise: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    serviceState: "announced",
    on: (event: string, listener: (value: unknown) => void) => listeners.set(event, listener),
  };
  createService.mockImplementation((options) =>
    Object.assign(service, {
      getFQDN: () => `${options.type}.${options.domain}.`,
      getHostname: () => options.hostname,
      getPort: () => options.port,
    }),
  );
  getResponder.mockReturnValue({ createService, shutdown });
  return service;
}

vi.mock("@homebridge/ciao/native.js", () => ({ getResponder }));
// mock-isolation: Test callback registration without installing process handlers or SDK runtime state.
vi.mock("openclaw/plugin-sdk/runtime", () => ({
  registerUncaughtExceptionHandler,
  registerUnhandledRejectionHandler,
}));

const { startGatewayBonjourAdvertiser } = await import("./advertiser.js");

afterAll(() => {
  vi.doUnmock("@homebridge/ciao/native.js");
  vi.doUnmock("openclaw/plugin-sdk/runtime");
  vi.resetModules();
});

let advertiser: Awaited<ReturnType<typeof startGatewayBonjourAdvertiser>> | undefined;
async function startAdvertiser(
  opts: Partial<Parameters<typeof startGatewayBonjourAdvertiser>[0]> = {},
) {
  return (advertiser = await startGatewayBonjourAdvertiser(
    { gatewayPort: 18789, sshPort: 2222, ...opts },
    logger,
  ));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected Bonjour callback registration");
  }
  return value;
}
const serviceOptions = () => required(createService.mock.calls[0]?.[0]);
const responderLogger = () => required(getResponder.mock.calls[0]?.[0]?.logger);

describe("gateway bonjour advertiser", () => {
  let service: ReturnType<typeof mockCiaoService>;
  beforeEach(() => {
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENCLAW_MDNS_HOSTNAME", "test-host");
    service = mockCiaoService();
  });

  afterEach(async () => {
    await advertiser?.stop();
    advertiser = undefined;
    vi.resetAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does not block on advertise and publishes expected txt keys", async () => {
    const pending = Promise.withResolvers<void>();
    service.advertise.mockReturnValue(pending.promise);
    await startAdvertiser({
      gatewayDirectReachable: true,
      tailnetDns: "host.tailnet.ts.net",
      cliPath: "/opt/homebrew/bin/openclaw",
    });
    expect(serviceOptions()).toMatchObject({
      type: "openclaw-gw",
      port: 18789,
      domain: "local",
      hostname: "test-host",
      txt: {
        lanHost: "test-host.local",
        gatewayPort: "18789",
        gatewayDirectReachable: "1",
        sshPort: "2222",
        tailnetDns: "host.tailnet.ts.net",
        cliPath: "/opt/homebrew/bin/openclaw",
        transport: "gateway",
      },
    });
    expectCalledOnce(service.advertise);
    pending.resolve();
    await Promise.resolve();
  });

  it("omits cliPath and sshPort in minimal mode", async () => {
    await startAdvertiser({
      cliPath: "/opt/homebrew/bin/openclaw",
      tailnetDns: "host.tailnet.ts.net",
      minimal: true,
    });
    const { txt } = serviceOptions();
    expect([txt.sshPort, txt.cliPath, txt.tailnetDns]).toEqual([undefined, undefined, undefined]);
  });

  it.each([
    ["explicit disable", "true", false, false, false],
    ["Docker", undefined, true, false, false],
    ["Fly", undefined, false, true, false],
    ["container opt-in", "0", true, false, true],
  ] as const)("applies %s discovery policy", async (_, disabled, docker, fly, enabled) => {
    vi.stubEnv("OPENCLAW_DISABLE_BONJOUR", disabled);
    vi.stubEnv("FLY_MACHINE_ID", fly ? "machine" : undefined);
    vi.stubEnv("FLY_APP_NAME", fly ? "app" : undefined);
    vi.spyOn(fs, "existsSync").mockImplementation((path) => docker && path === "/.dockerenv");
    const started = await startAdvertiser();
    expect(createService).toHaveBeenCalledTimes(enabled ? 1 : 0);
    await expect(started.stop()).resolves.toBeUndefined();
  });

  it("cleans up ciao process handlers after shutdown, only once for concurrent stops", async () => {
    const order: string[] = [];
    shutdown.mockImplementation(async () => void order.push("shutdown"));
    const cleanupException = vi.fn(() => void order.push("cleanup-exception"));
    const cleanupRejection = vi.fn(() => void order.push("cleanup-rejection"));
    registerUncaughtExceptionHandler.mockReturnValue(cleanupException);
    registerUnhandledRejectionHandler.mockReturnValue(cleanupRejection);
    const started = await startAdvertiser();
    await Promise.all([started.stop(), started.stop()]);
    expectCalledOnce(cleanupException, cleanupRejection, service.destroy, shutdown);
    expect(order).toEqual(["shutdown", "cleanup-exception", "cleanup-rejection"]);
  });

  it.each([
    [
      new Error(
        "IP address version must match. Netmask cannot have a version different from the address!",
      ),
      "suppressing ciao netmask assertion",
    ],
    [
      Object.assign(new Error("uv_interface_addresses"), { name: "SystemError" }),
      "disabling mDNS — networkInterfaces() unavailable in this environment: SystemError: uv_interface_addresses",
    ],
  ])("handles ciao process error %s directly and wrapped", async (error, warning) => {
    await startAdvertiser();
    for (const registration of [
      registerUncaughtExceptionHandler,
      registerUnhandledRejectionHandler,
    ]) {
      const handler = required(registration.mock.calls[0]?.[0]);
      for (const reason of [error, new Error("ciao init failed", { cause: error })]) {
        logger.warn.mockClear();
        expect(handler(reason)).toBe(true);
        expectWarnContaining(warning);
      }
      logger.warn.mockClear();
      expect(handler(new Error("boom"))).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
    }
  });

  it.each([
    [Object.assign(new Error("   "), { name: "AbortError" }), "AbortError"],
    [new Error("   "), "Error"],
    ["boom", "boom"],
  ])("formats advertise rejection %j as %s", async (error, formatted) => {
    service.advertise.mockRejectedValue(error);
    service.serviceState = "unannounced";
    await startAdvertiser();
    await Promise.resolve();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      `bonjour: advertise failed (gateway fqdn=openclaw-gw.local. host=test-host port=18789 state=unannounced): ${formatted}`,
    );
  });

  it("logs advertise failures without starting a competing retry loop", async () => {
    vi.useFakeTimers();
    service.advertise.mockRejectedValue(new Error("boom"));
    service.serviceState = "unannounced";
    const started = await startAdvertiser();
    await Promise.resolve();
    expectWarnContaining("advertise failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expectCalledOnce(service.advertise, createService);
    await started.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expectCalledOnce(service.advertise);
  });

  it("handles advertise throwing synchronously", async () => {
    service.advertise.mockImplementation(() => {
      throw new Error("sync-fail");
    });
    service.serviceState = "unannounced";
    await startAdvertiser();
    expectWarnContaining("advertise threw");
  });

  it.each([
    [
      "log",
      "failed probing with reason: Error: Can't probe for a service which is announced already.",
    ],
    ["warn", "Encountered MDNS socket error on socket 'br': send ENODEV"],
  ] as const)("filters ciao %s noise only", async (method, noise) => {
    await startAdvertiser();
    const destination = method === "log" ? logger.info : logger.warn;
    destination.mockClear();
    const ciaoLogger = responderLogger();
    ciaoLogger[method](noise);
    ciaoLogger[method]("ordinary %s", "ciao line");
    expect(destination).toHaveBeenCalledExactlyOnceWith("bonjour: ordinary ciao line");
  });

  it("routes ciao errors without replacing or filtering the process console", async () => {
    const methods = ["log", "warn", "error"] as const;
    const originals = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const expectConsoleUnchanged = () =>
      expect(methods.map((method) => console[method])).toEqual(originals);
    const started = await startAdvertiser();
    expectConsoleUnchanged();
    const noise = "Encountered MDNS socket error on socket 'example': send ENODEV";
    console.warn(noise);
    expect(originals[1]).toHaveBeenCalledExactlyOnceWith(noise);
    responderLogger().error("socket %s", "failed");
    expect(logger.error).toHaveBeenCalledExactlyOnceWith("bonjour: socket failed");
    await started.stop();
    expectConsoleUnchanged();
  });

  it("never overlaps ciao lifecycle states or conflict handling with another advertise call", async () => {
    vi.useFakeTimers();
    service.serviceState = "unannounced";
    service.advertise.mockReturnValue(new Promise<void>(() => {}));
    const started = await startAdvertiser();
    for (const state of ["probing", "announcing", "unannounced", "probed", "announced"]) {
      service.serviceState = state;
      await vi.advanceTimersByTimeAsync(60_000);
    }
    service.listeners.get("name-change")?.("test-host (OpenClaw) (2)");
    service.listeners.get("hostname-change")?.("test-host-(2)");
    expectWarnContaining('name conflict resolved; newName="test-host (OpenClaw) (2)"');
    expectWarnContaining('hostname conflict resolved; newHostname="test-host-(2)"');
    expectCalledOnce(createService, service.advertise);
    expect(service.destroy).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(warnMessages()).not.toMatch(/watchdog|restarting advertiser|disabling advertiser/);
    await started.stop();
    expectCalledOnce(service.destroy, shutdown);
  });

  it.each([
    ["Mac.localdomain", "Mac"],
    ["My_Lobster Host", "openclaw"],
  ])("normalizes system hostname %s for DNS", async (raw, hostname) => {
    vi.stubEnv("OPENCLAW_MDNS_HOSTNAME", undefined);
    vi.spyOn(os, "hostname").mockReturnValue(raw);
    await startAdvertiser();
    expect(serviceOptions()).toMatchObject({
      name: `${hostname} (OpenClaw)`,
      domain: "local",
      hostname,
      txt: { lanHost: `${hostname}.local` },
    });
  });

  it.each([
    ["ASCII", "a".repeat(64), "a".repeat(63)],
    ["UTF-8", "你".repeat(21), "你".repeat(21)],
  ])("keeps %s hostname and service labels within DNS byte limits", async (_, raw, expected) => {
    vi.stubEnv("OPENCLAW_MDNS_HOSTNAME", raw);
    await startAdvertiser();
    const { name, hostname } = serviceOptions();
    expect(hostname).toBe(expected);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    expect(name).not.toMatch(/\uFFFD$/);
  });
});
