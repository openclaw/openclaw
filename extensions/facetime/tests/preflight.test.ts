import { afterEach, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/realtime-voice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/realtime-voice")>()),
  resolveConfiguredRealtimeVoiceProviderAsync: vi.fn(
    ({ providerConfigs }: { providerConfigs?: Record<string, Record<string, unknown>> }) => {
      const selected = Object.entries(providerConfigs ?? {}).find(
        ([, config]) => typeof config.apiKey === "string" && config.apiKey.length > 0,
      );
      if (!selected) {
        throw new Error("No configured realtime voice provider registered");
      }
      return { provider: { id: selected[0] }, providerConfig: selected[1] };
    },
  ),
}));

import { resolveFaceTimeConfig } from "../src/config.js";
import { runFaceTimePreflight } from "../src/preflight.js";

function runtimeWithCommands(runCommandWithTimeout: ReturnType<typeof vi.fn>) {
  return { system: { runCommandWithTimeout } } as never;
}
const commandResult = (stdout = "", stderr = "", code = 0) => ({ code, stdout, stderr });
const checkIds = [
  "helper-connected",
  "capture-binary",
  "call-app-running",
  "paired-driver-mic",
  "paired-driver-feed",
  "physical-output",
  "process-tap",
  "realtime-provider",
];

const defaults = {
  input: { isAggregate: false, name: "Mac Mic", uid: "mic" },
  output: { isAggregate: false, name: "Mac Speakers", uid: "speakers" },
};
const audioProfile = (names: string[], virtual = false) =>
  JSON.stringify({
    SPAudioDataType: [
      {
        _items: names.map((_name) => ({
          _name,
          ...(virtual ? { coreaudio_device_transport: "coreaudio_device_type_virtual" } : {}),
        })),
      },
    ],
  });
const config = (overrides: Record<string, unknown> = {}) =>
  resolveFaceTimeConfig({ ownerHandles: ["omar@example.com"], ...overrides });

function preflight({
  output = defaults.output,
  profiler = audioProfile(["OpenClaw-Mic", "OpenClaw-Feed"]),
  ...overrides
}: Partial<Parameters<typeof runFaceTimePreflight>[0]> & {
  output?: typeof defaults.output;
  profiler?: string;
} = {}) {
  const responses = new Map([
    ["/bin/test", commandResult()],
    ["/usr/bin/pgrep", commandResult("123\n")],
    ["/usr/sbin/system_profiler", commandResult(profiler)],
    ["--default-devices", commandResult(JSON.stringify({ ...defaults, output }))],
    ["--check", commandResult("", "capture ready")],
  ]);
  const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
    const response = responses.get(argv[0] ?? "") ?? responses.get(argv.at(-1) ?? "");
    if (!response) {
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    }
    return response;
  });

  return runFaceTimePreflight({
    config: config({
      realtime: { providers: { openai: { apiKey: "test-api-key" } } },
    }),
    fullConfig: {},
    runtime: runtimeWithCommands(runCommandWithTimeout),
    helperConnected: true,
    captureBinary: "/capture",
    ...overrides,
  });
}

it.each([true, false])(
  "reports all readiness checks with dependencies available=%s",
  async (available) => {
    const result = await preflight(
      available
        ? {}
        : {
            config: config(),
            runtime: runtimeWithCommands(vi.fn().mockResolvedValue(commandResult("", "ENOENT", 1))),
            helperConnected: false,
            captureBinary: "/missing/capture",
          },
    );
    expect(result.ok).toBe(available);
    if (available) {
      expect(result.currentAudioDefaults).toEqual(defaults);
    }
    expect(result.checks.map((check) => [check.id, check.ok, check.required])).toEqual(
      checkIds.map((id) => [id, available, true]),
    );
  },
);

afterEach(() => vi.unstubAllEnvs());

it.each(["{invalid", "        OpenClaw-Mic:\n        OpenClaw-Feed:\n"])(
  "reports missing driver devices when system_profiler violates its JSON contract: %s",
  async (profiler) => {
    const result = await preflight({ profiler });
    expect(result.ok).toBe(false);
    expect(result.checks.filter((check) => check.id.startsWith("paired-driver-"))).toEqual([
      expect.objectContaining({ id: "paired-driver-mic", ok: false }),
      expect.objectContaining({ id: "paired-driver-feed", ok: false }),
    ]);
  },
);

it("fails provider readiness for an unresolved configured SecretRef", async () => {
  const missingKey = "OPENCLAW_FACETIME_TEST_MISSING_KEY";
  vi.stubEnv(missingKey, undefined);
  const result = await preflight({
    config: config({
      realtime: {
        providers: { openai: { apiKey: { source: "env", provider: "default", id: missingKey } } },
      },
    }),
    fullConfig: { secrets: { providers: { default: { source: "env" } } } },
  });
  expect(result.checks.find((check) => check.id === "realtime-provider")?.ok).toBe(false);
  expect(result.ok).toBe(false);
});

it.each([
  [true, "Aggregate Device", "aggregate"],
  [false, "OpenClaw-Feed", "virtual"],
] as const)("rejects aggregate=%s output %s", async (isAggregate, name, message) => {
  const output = { isAggregate, name, uid: "output" };
  const result = await preflight({ output });

  expect(result.checks.find((check) => check.id === "physical-output")).toMatchObject({
    ok: false,
    message: expect.stringContaining(message),
  });
});

it("rejects a virtual default output reported by Core Audio transport metadata", async () => {
  const output = { isAggregate: false, name: "Jump Desktop Audio", uid: "jump-audio" };
  const result = await preflight({
    output,
    profiler: audioProfile(["OpenClaw-Mic", "OpenClaw-Feed", output.name], true),
  });

  expect(result.checks.find((check) => check.id === "physical-output")).toMatchObject({
    ok: false,
    message: "system output is virtual device Jump Desktop Audio",
  });
});
