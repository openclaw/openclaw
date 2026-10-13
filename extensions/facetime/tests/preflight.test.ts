import { afterEach, describe, expect, it, vi } from "vitest";

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

const defaults = {
  input: { isAggregate: false, name: "Mac Mic", uid: "mic" },
  output: { isAggregate: false, name: "Mac Speakers", uid: "speakers" },
};

function preflight({
  output = defaults.output,
  profiler = "        OpenClaw-Mic:\n        OpenClaw-Feed:\n",
  ...overrides
}: Partial<Parameters<typeof runFaceTimePreflight>[0]> & {
  output?: typeof defaults.output;
  profiler?: string;
} = {}) {
  const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
    if (argv[0] === "/bin/test") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (argv[0] === "/usr/bin/pgrep") {
      return { code: 0, stdout: "123\n", stderr: "" };
    }
    if (argv[0] === "/usr/sbin/system_profiler") {
      return {
        code: 0,
        stdout: profiler,
        stderr: "",
      };
    }
    if (argv.at(-1) === "--default-devices") {
      return { code: 0, stdout: JSON.stringify({ ...defaults, output }), stderr: "" };
    }
    if (argv.at(-1) === "--check") {
      return { code: 0, stdout: "", stderr: "capture ready" };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  });

  return runFaceTimePreflight({
    config: resolveFaceTimeConfig({
      ownerHandles: ["omar@example.com"],
      realtime: { providers: { openai: { apiKey: "test-api-key" } } },
    }),
    fullConfig: {},
    runtime: runtimeWithCommands(runCommandWithTimeout),
    helperConnected: true,
    captureBinary: "/capture",
    ...overrides,
  });
}

describe("FaceTime preflight", () => {
  it("passes the paired-driver, process-tap, output, and provider checks", async () => {
    const result = await preflight();
    expect(result.ok).toBe(true);
    expect(result.currentAudioDefaults).toEqual(defaults);
    expect(result.checks.map((check) => [check.id, check.ok, check.required])).toEqual([
      ["helper-connected", true, true],
      ["capture-binary", true, true],
      ["call-app-running", true, true],
      ["paired-driver-mic", true, true],
      ["paired-driver-feed", true, true],
      ["physical-output", true, true],
      ["process-tap", true, true],
      ["realtime-provider", true, true],
    ]);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("fails provider readiness for an unresolved configured SecretRef", async () => {
    const missingKey = "OPENCLAW_FACETIME_TEST_MISSING_KEY";
    vi.stubEnv(missingKey, undefined);
    const result = await preflight({
      config: resolveFaceTimeConfig({
        ownerHandles: ["omar@example.com"],
        realtime: {
          providers: { openai: { apiKey: { source: "env", provider: "default", id: missingKey } } },
        },
      }),
      fullConfig: { secrets: { providers: { default: { source: "env" } } } },
    });
    expect(result.checks.find((check) => check.id === "realtime-provider")?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("reports actionable readiness failures", async () => {
    const result = await preflight({
      config: resolveFaceTimeConfig({ ownerHandles: ["omar@example.com"] }),
      runtime: runtimeWithCommands(
        vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "ENOENT" }),
      ),
      helperConnected: false,
      captureBinary: "/missing/capture",
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.filter((check) => check.required && !check.ok).map((check) => check.id),
    ).toEqual([
      "helper-connected",
      "capture-binary",
      "call-app-running",
      "paired-driver-mic",
      "paired-driver-feed",
      "physical-output",
      "process-tap",
      "realtime-provider",
    ]);
  });

  it.each([
    {
      name: "aggregate output",
      output: { isAggregate: true, name: "Aggregate Device", uid: "aggregate" },
      message: "aggregate",
    },
    {
      name: "virtual output",
      output: { isAggregate: false, name: "OpenClaw-Feed", uid: "feed" },
      message: "virtual",
    },
  ])("rejects $name at the preflight boundary", async ({ output, message }) => {
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
      profiler: JSON.stringify({
        SPAudioDataType: [
          {
            _name: "coreaudio_device",
            _items: ["OpenClaw-Mic", "OpenClaw-Feed", output.name].map((_name) => ({
              _name,
              coreaudio_device_transport: "coreaudio_device_type_virtual",
            })),
          },
        ],
      }),
    });

    expect(result.checks.find((check) => check.id === "physical-output")).toMatchObject({
      ok: false,
      message: "system output is virtual device Jump Desktop Audio",
    });
  });
});
