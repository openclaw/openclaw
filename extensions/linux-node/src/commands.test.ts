import type { CommandOptions, SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLinuxNodeCommands } from "./commands.js";
import type { ResolvedLinuxNodePluginConfig } from "./config.js";

const boundary = vi.hoisted(() => ({
  runCommand: vi.fn<(argv: string[], options: CommandOptions) => Promise<SpawnResult>>(),
  resolveExecutable: vi.fn<typeof import("./executables.js").resolveExecutable>(),
  readdir: vi.fn<() => Promise<string[]>>(),
  readFile: vi.fn<(filePath: string) => Promise<Buffer | string>>(),
  stat: vi.fn<(filePath: string) => Promise<{ size: number }>>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: {
      ...actual,
      readdir: boundary.readdir,
      readFile: boundary.readFile,
      stat: boundary.stat,
    },
  };
});
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandWithTimeout: boundary.runCommand,
}));
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  withTempWorkspace: async (_options: unknown, run: (workspace: { dir: string }) => unknown) =>
    await run({ dir: "/tmp" }),
}));
vi.mock("./executables.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./executables.js")>()),
  resolveExecutable: boundary.resolveExecutable,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

type HarnessOptions = {
  config?: ResolvedLinuxNodePluginConfig;
  platform?: NodeJS.Platform;
  resolveExecutable?: typeof import("./executables.js").resolveExecutable;
  runCommand?: (argv: string[], options: CommandOptions) => Promise<SpawnResult>;
  readFile?: (filePath: string) => Promise<Buffer>;
  statFile?: (filePath: string) => Promise<{ size: number }>;
  now?: Date;
};

const maxMediaRawBytes = Math.floor((25 * 1024 * 1024 - 64 * 1024) / 4) * 3;

const enabledConfig: ResolvedLinuxNodePluginConfig = {
  notify: { enabled: true },
  camera: { enabled: true },
  location: { enabled: true },
};

function success(stdout = ""): SpawnResult {
  return {
    stdout,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    noOutputTimedOut: false,
  };
}

const jpeg640x480 = Buffer.from("ffd8ffc0000b0801e0028001011100ffd9", "hex");

function createHarness(overrides: HarnessOptions = {}) {
  const runCommand = vi.fn(async (_argv: string[], _options: CommandOptions) => success());
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: overrides.platform ?? "linux",
  });
  vi.stubEnv("PATH", "/usr/bin");
  vi.setSystemTime(overrides.now ?? new Date("2026-07-13T12:00:10.000Z"));
  boundary.resolveExecutable.mockImplementation(
    overrides.resolveExecutable ?? ((command) => `/usr/bin/${command}`),
  );
  boundary.readdir.mockResolvedValue(["video0"]);
  boundary.readFile.mockImplementation(async (filePath) =>
    filePath.startsWith("/sys/")
      ? "Test Camera\n"
      : overrides.readFile
        ? await overrides.readFile(filePath)
        : filePath.endsWith(".jpg")
          ? jpeg640x480
          : Buffer.from("mp4"),
  );
  boundary.stat.mockImplementation(
    overrides.statFile ??
      (async (filePath) => ({ size: filePath.endsWith(".jpg") ? jpeg640x480.length : 3 })),
  );
  boundary.runCommand.mockImplementation(async (argv, options) =>
    argv.includes("-list_formats")
      ? success("[video4linux2,v4l2] Raw : yuyv422 : YUYV 4:2:2")
      : await (overrides.runCommand ?? runCommand)(argv, options),
  );
  const commands = createLinuxNodeCommands(overrides.config ?? enabledConfig);
  const command = (name: string) => {
    const found = commands.find((entry) => entry.command === name);
    if (!found) {
      throw new Error(`missing command ${name}`);
    }
    return found;
  };
  const invoke = async (name: string, params?: Record<string, unknown>): Promise<unknown> =>
    JSON.parse(await command(name).handle(JSON.stringify(params)));
  return { command, invoke, runCommand };
}

describe("linux-node commands", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("lists only V4L2 nodes that expose capture formats through FFmpeg", async () => {
    const runCommand = vi.fn(async (argv: string[]) =>
      success(
        argv.at(-1) === "/dev/video0"
          ? "[video4linux2,v4l2] Raw : yuyv422 : YUYV 4:2:2"
          : "Not a video capture device",
      ),
    );
    const { command } = createHarness();
    boundary.readdir.mockResolvedValue(["video1", "media0", "video0"]);
    boundary.readFile.mockResolvedValue("Integrated Camera\n");
    boundary.runCommand.mockImplementation(runCommand);
    await expect(command("camera.list").handle()).resolves.toBe(
      JSON.stringify({
        devices: [
          {
            id: "/dev/video0",
            name: "Integrated Camera",
            position: "unknown",
            deviceType: "v4l2",
          },
        ],
      }),
    );
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("advertises only enabled Linux capabilities with cached tooling", () => {
    const resolver = vi.fn((command: string) =>
      command === "where-am-i" ? null : `/usr/bin/${command}`,
    );
    const { command } = createHarness({ resolveExecutable: resolver });
    const context = {
      config: { plugins: { entries: { "linux-node": { config: enabledConfig } } } },
      env: { PATH: "/usr/bin" },
    };

    expect(command("system.notify").isAvailable?.(context)).toBe(true);
    expect(command("camera.list").isAvailable?.(context)).toBe(true);
    expect(command("location.get").isAvailable?.(context)).toBe(false);

    const disabledCameraContext = structuredClone(context);
    disabledCameraContext.config.plugins.entries["linux-node"].config.camera.enabled = false;
    expect(command("camera.list").isAvailable?.(disabledCameraContext)).toBe(false);

    const nonLinux = createHarness({ platform: "darwin" }).command("system.notify");
    expect(nonLinux.isAvailable?.(context)).toBe(false);
  });

  it("maps notification priority and ignores sound and delivery", async () => {
    const { command, runCommand } = createHarness();
    await expect(
      command("system.notify").handle(
        JSON.stringify({
          title: "Build complete",
          body: "All checks passed",
          priority: "timeSensitive",
          sound: "default",
          delivery: "system",
        }),
      ),
    ).resolves.toBe('{"ok":true}');
    expect(runCommand).toHaveBeenCalledWith(
      [
        "/usr/bin/notify-send",
        "--urgency",
        "critical",
        "--",
        "Build complete",
        "All checks passed",
      ],
      { timeoutMs: 10_000 },
    );
  });

  it("accepts either notification field but rejects an empty notification", async () => {
    const { command, runCommand } = createHarness();
    await expect(
      command("system.notify").handle(JSON.stringify({ title: "Status", body: "" })),
    ).resolves.toBe('{"ok":true}');
    expect(runCommand.mock.calls[0]?.[0]).toEqual([
      "/usr/bin/notify-send",
      "--urgency",
      "normal",
      "--",
      "Status",
      "",
    ]);
    await expect(command("system.notify").handle("{}")).rejects.toThrow(
      "INVALID_REQUEST: empty notification",
    );
  });

  it("maps snap defaults and clamps delay and quality", async () => {
    const { invoke, runCommand } = createHarness();
    const payload = await invoke("camera.snap", {
      deviceId: "/dev/video0",
      delayMs: 50_000,
      quality: 2,
      maxWidth: -1,
      format: "jpeg",
    });
    const argv = runCommand.mock.calls[0]?.[0];

    expect(argv).toContain("10.000");
    expect(argv).toContain("scale=min(iw\\,1600):-2");
    expect(argv).toContain("2");
    expect(payload).toEqual({
      format: "jpeg",
      base64: jpeg640x480.toString("base64"),
      width: 640,
      height: 480,
    });
  });

  it("records clip audio through PulseAudio and clamps duration", async () => {
    const { invoke, runCommand } = createHarness();
    const payload = await invoke("camera.clip", { durationMs: 1 });
    const argv = runCommand.mock.calls[0]?.[0];

    expect(argv).toEqual(
      expect.arrayContaining(["-f", "pulse", "-i", "default", "-t", "0.250", "-c:a", "aac"]),
    );
    expect(payload).toEqual({
      format: "mp4",
      base64: Buffer.from("mp4").toString("base64"),
      durationMs: 250,
      hasAudio: true,
    });
  });

  it("maps GeoClue accuracy and parses a fresh location payload", async () => {
    const output = `Client object: /org/freedesktop/GeoClue2/Client/1\n\nNew location:\nLatitude:    48.208490°\nLongitude:   16.372080°\nAccuracy:    12.500000 meters\nAltitude:    182.000000 meters\nSpeed:       0.000000 meters/second\nHeading:     270.000000°\nTimestamp:   Mon Jul 13 12:00:00 2026 (1783944000 seconds since the Epoch)\n`;
    const runCommand = vi.fn(async (_argv: string[], options: CommandOptions) => {
      options.onOutputChunk?.(Buffer.from(output), "stdout");
      return success(output);
    });
    const { invoke } = createHarness({ runCommand });
    const payload = await invoke("location.get", {
      timeoutMs: 100,
      maxAgeMs: 20_000,
      desiredAccuracy: "precise",
    });

    expect(runCommand.mock.calls[0]?.[0]).toEqual(["/usr/bin/where-am-i", "-t", "1", "-a", "8"]);
    expect(payload).toEqual({
      lat: 48.20849,
      lon: 16.37208,
      accuracyMeters: 12.5,
      altitudeMeters: 182,
      speedMps: 0,
      headingDeg: 270,
      timestamp: "2026-07-13T12:00:00.000Z",
      isPrecise: true,
      source: "unknown",
    });
  });

  it.each([
    ["stale", "11:00:00", "12:00:05", 20_000],
    ["future-dated", "12:00:15", "12:00:09", 2000],
  ])(
    "keeps GeoClue running past a %s fix until a fresh update arrives",
    async (_kind, rejectedTime, acceptedTime, maxAgeMs) => {
      const fix = (lat: number, time: string) =>
        `\nNew location:\nLatitude: ${lat}\nLongitude: 16\nAccuracy: 25 meters\nTimestamp: now (${Date.parse(`2026-07-13T${time}.000Z`) / 1000} seconds since the Epoch)\n`;
      const rejected = fix(47, rejectedTime);
      const accepted = fix(48, acceptedTime);
      const { invoke } = createHarness({
        runCommand: async (_argv, options) => {
          expect(options.onOutputChunk?.(Buffer.from(rejected), "stdout")).toBe(true);
          expect(options.onOutputChunk?.(Buffer.from(accepted), "stdout")).toBe(false);
          return success(`${rejected}${accepted}`);
        },
      });
      expect(await invoke("location.get", { maxAgeMs })).toMatchObject({
        lat: 48,
        timestamp: `2026-07-13T${acceptedTime}.000Z`,
      });
    },
  );

  it("accounts for GeoClue second precision when maxAgeMs is zero", async () => {
    const output = `\nNew location:\nLatitude: 48\nLongitude: 16\nAccuracy: 25 meters\nTimestamp: now (1783944010 seconds since the Epoch)\n`;
    const harness = createHarness({
      now: new Date("2026-07-13T12:00:10.900Z"),
      runCommand: async () => success(output),
    });

    await expect(
      harness.command("location.get").handle(JSON.stringify({ maxAgeMs: 0 })),
    ).resolves.toContain('"timestamp":"2026-07-13T12:00:10.000Z"');
  });

  it("returns stable location timeout and unavailable errors", async () => {
    const timeout = createHarness({ runCommand: async () => success("") });
    await expect(timeout.command("location.get").handle()).rejects.toThrow(
      "LOCATION_TIMEOUT: no fix in time",
    );

    const unavailable = createHarness({
      runCommand: async () => ({ ...success(), code: 1, stderr: "GeoClue service unavailable" }),
    });
    await expect(unavailable.command("location.get").handle()).rejects.toThrow(
      "LOCATION_UNAVAILABLE: GeoClue service unavailable",
    );

    const disabled = createHarness({
      runCommand: async () => success("Geolocation disabled. Quitting..\n"),
    });
    await expect(disabled.command("location.get").handle()).rejects.toThrow(
      "LOCATION_DISABLED: GeoClue location services are disabled",
    );

    const revokedOutput =
      "New location:\nLatitude: 48\nLongitude: 16\nAccuracy: 25 meters\nAccessDenied: Geolocation disabled for UID 1000\n";
    const revoked = createHarness({
      runCommand: async (_argv, options) => {
        expect(options.onOutputChunk?.(Buffer.from(revokedOutput), "stdout")).toBe(false);
        return success(revokedOutput);
      },
    });
    await expect(revoked.command("location.get").handle()).rejects.toThrow(
      "LOCATION_DISABLED: GeoClue location services are disabled",
    );
  });

  it("gates handlers even when invoked without advertisement", async () => {
    const { command } = createHarness({
      config: {
        notify: { enabled: true },
        camera: { enabled: false },
        location: { enabled: false },
      },
    });
    await expect(command("camera.list").handle()).rejects.toThrow("CAMERA_DISABLED");
    await expect(command("location.get").handle()).rejects.toThrow("LOCATION_DISABLED");
  });

  it("rejects media beyond the 25 MB base64 budget", async () => {
    const readFile = vi.fn(async () => Buffer.alloc(maxMediaRawBytes + 1));
    const { command } = createHarness({
      readFile,
      statFile: async () => ({ size: maxMediaRawBytes + 1 }),
    });
    await expect(command("camera.clip").handle()).rejects.toThrow("PAYLOAD_TOO_LARGE");
    expect(readFile).not.toHaveBeenCalled();
  });
});
