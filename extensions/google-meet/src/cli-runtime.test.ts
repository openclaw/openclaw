import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GoogleMeetRuntime } from "./runtime.js";
import * as cli from "./test-support/cli-harness.js";
import { MEET_URL, meetSession } from "./test-support/fixtures.test-helpers.js";

const session = meetSession({ id: "meet_gateway", transport: "chrome-node" });

let stdout: ReturnType<typeof cli.captureStdout>;
async function runCli(params: Parameters<typeof cli.setupCli>[0], args: string[]) {
  stdout.restore();
  stdout = cli.captureStdout();
  await cli.setupCli(params).parseAsync(["googlemeet", ...args], { from: "user" });
  return stdout;
}
function runRuntime(
  runtime: NonNullable<Parameters<typeof cli.setupCli>[0]["runtime"]>,
  args: string[],
) {
  return runCli({ runtime }, args);
}

function runSetup(ok: boolean, id: string, message: string, args: string[]) {
  return runRuntime({ setupStatus: async () => ({ ok, checks: [{ id, ok, message }] }) }, args);
}

beforeEach(() => {
  stdout = cli.captureStdout();
});
afterEach(() => {
  stdout.restore();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

type Result = Awaited<ReturnType<GoogleMeetRuntime["speak"]>> & { browserLeft?: boolean };
type Case = ["leave" | "speak", Result, string | Error];
const blocked = (message: string) =>
  meetSession({ chrome: { health: { speechBlockedMessage: message } } });
const cases: Case[] = [
  ["leave", { found: false, spoken: false }, new Error("session not found")],
  ["leave", { found: true, spoken: false }, "left meet_1\n"],
  [
    "leave",
    { found: true, spoken: false, browserLeft: false },
    "left meet_1, but the browser participant may still be in the call; check session notes\n",
  ],
  [
    "speak",
    { found: false, spoken: false, session: blocked("blocked") },
    new Error("session not found"),
  ],
  [
    "speak",
    { found: true, spoken: false, session: blocked("microphone muted") },
    new Error("microphone muted"),
  ],
  [
    "speak",
    { found: true, spoken: false },
    new Error("session has no active realtime audio bridge"),
  ],
  ["speak", { found: true, spoken: true }, "speaking on meet_1\n"],
];

it.each(cases)("%s returns %j", async (command, result, expected) => {
  const calls: string[] = [];
  const leave = vi.fn<GoogleMeetRuntime["leave"]>(async () => {
    calls.push("leave");
    return result;
  });
  const speak = vi.fn<GoogleMeetRuntime["speak"]>(async () => {
    calls.push("speak");
    return result;
  });
  const ensureRuntime = vi.fn(async () => {
    calls.push("runtime");
    return { leave, speak } as unknown as GoogleMeetRuntime;
  });
  const callGatewayFromCli = vi.fn<
    NonNullable<Parameters<typeof cli.setupCli>[0]["callGatewayFromCli"]>
  >(async () => {
    calls.push("gateway");
    throw Object.assign(new Error(`unknown method: googlemeet.${command}`), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
      retryable: false,
    });
  });
  const args = ["googlemeet", command, "meet_1"];
  if (command === "speak") {
    args.push("hello meeting");
  }
  const parsed = cli.setupCli({ callGatewayFromCli, ensureRuntime }).parseAsync(args, {
    from: "user",
  });
  if (expected instanceof Error) {
    await expect(parsed).rejects.toEqual(expected);
  } else {
    await parsed;
  }
  expect(stdout.output()).toBe(expected instanceof Error ? "" : expected);
  expect(calls).toEqual(["gateway", "runtime", command]);
  expect(callGatewayFromCli).toHaveBeenCalledWith(
    `googlemeet.${command}`,
    { json: true, timeout: "5000" },
    { sessionId: "meet_1", ...(command === "speak" ? { message: "hello meeting" } : {}) },
    { progress: false },
  );
  expect(leave.mock.calls).toEqual(command === "leave" ? [["meet_1"]] : []);
  expect(speak.mock.calls).toEqual(command === "speak" ? [["meet_1", "hello meeting"]] : []);
});

it("prints setup checks as text and JSON", async () => {
  await runSetup(
    true,
    "audio-bridge",
    "Chrome command-pair talk-back audio bridge configured (pcm16-24khz)",
    ["setup"],
  );
  expect(stdout.output()).toContain("Google Meet setup: OK");
  expect(stdout.output()).toContain(
    "[ok] audio-bridge: Chrome command-pair talk-back audio bridge configured (pcm16-24khz)",
  );
  expect(stdout.output()).not.toContain('"checks"');

  await runSetup(false, "twilio-voice-call-plugin", "missing", ["setup", "--json"]);
  expect(cli.parseStdoutJson(stdout)).toMatchObject({
    ok: false,
    checks: [{ id: "twilio-voice-call-plugin", ok: false }],
  });
  expect(process.exitCode).toBe(1);
});

it("rejects unknown setup mode and transport values", async () => {
  const setupStatus = vi.fn<NonNullable<GoogleMeetRuntime["setupStatus"]>>();
  const program = cli.setupCli({ runtime: { setupStatus } });

  await expect(
    program.parseAsync(["googlemeet", "setup", "--mode", "agnt"], { from: "user" }),
  ).rejects.toThrow("mode must be agent, bidi, transcribe, or realtime; received agnt");
  await expect(
    program.parseAsync(["googlemeet", "setup", "--transport", "definitely-not-a-transport"], {
      from: "user",
    }),
  ).rejects.toThrow(
    "transport must be chrome, chrome-node, or twilio; received definitely-not-a-transport",
  );
  expect(setupStatus).not.toHaveBeenCalled();
});

it("accepts --json on session status", async () => {
  await runRuntime(
    {
      status: async () => ({
        found: true,
        sessions: [
          {
            ...session,
            id: "meet_1",
            transport: "twilio",
            participantIdentity: "Twilio PSTN participant",
          },
        ],
      }),
    },
    ["status", "--json"],
  );
  expect(cli.parseStdoutJson(stdout)).toMatchObject({
    found: true,
    sessions: [{ id: "meet_1", transport: "twilio" }],
  });
});

it("prints cursor-based transcripts from the gateway-owned runtime", async () => {
  const callGatewayFromCli = vi.fn(async () => ({
    found: true,
    sessionId: "meet_gateway",
    startIndex: 3,
    nextIndex: 4,
    droppedLines: 2,
    lines: [{ at: "2026-07-12T06:00:00.000Z", speaker: "Alice", text: "fourth line" }],
  }));

  await runCli({ callGatewayFromCli }, ["transcript", "meet_gateway", "--since", "3"]);
  expect(callGatewayFromCli).toHaveBeenCalledWith(
    "googlemeet.transcript",
    { json: true, timeout: "5000" },
    { sessionId: "meet_gateway", sinceIndex: 3 },
    { progress: false },
  );
  expect(stdout.output()).toContain("# 2 earlier lines dropped by the transcript cap");
  expect(stdout.output()).toContain("Alice: fourth line");
  expect(stdout.output()).toContain("# nextIndex: 4");
});

it.each(["9007199254740992"])(
  "rejects invalid transcript cursors before gateway delegation: %s",
  async (since) => {
    const callGatewayFromCli = vi.fn();

    await expect(
      cli
        .setupCli({ callGatewayFromCli })
        .parseAsync(["googlemeet", "transcript", "meet_gateway", "--since", since], {
          from: "user",
        }),
    ).rejects.toThrow("--since must be a non-negative safe integer");

    expect(callGatewayFromCli).not.toHaveBeenCalled();
  },
);

it.each([
  {
    command: "join",
    method: "googlemeet.join",
    transport: "chrome-node",
    mode: "realtime",
    result: { session: { ...session, mode: "realtime" } },
    expected: { id: "meet_gateway", transport: "chrome-node" },
    extraParams: { dialInNumber: undefined, pin: undefined, dtmfSequence: undefined },
  },
  {
    command: "test-speech",
    method: "googlemeet.testSpeech",
    transport: "chrome",
    mode: "bidi",
    result: {
      createdSession: true,
      session: {
        ...session,
        transport: "chrome",
        mode: "bidi",
        participantIdentity: "signed-in Google Chrome profile",
        realtime: { enabled: true, strategy: "bidi", provider: "openai" },
      },
    },
    expected: { createdSession: true, session: { mode: "bidi" } },
    extraParams: {},
  },
])(
  "delegates $command to the gateway-owned runtime",
  async ({ command, method, transport, mode, result, expected, extraParams }) => {
    const callGatewayFromCli = vi.fn(async () => result);
    const ensureRuntime = vi.fn(async () => {
      throw new Error("local runtime should not be loaded");
    });
    await runCli({ callGatewayFromCli, ensureRuntime }, [
      command,
      MEET_URL,
      "--transport",
      transport,
      "--mode",
      mode,
      "--message",
      "Hello meeting",
    ]);
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      method,
      { json: true, timeout: "60000" },
      { url: MEET_URL, transport, mode, message: "Hello meeting", ...extraParams },
      { progress: false },
    );
    expect(ensureRuntime).not.toHaveBeenCalled();
    expect(cli.parseStdoutJson(stdout)).toMatchObject(expected);
  },
);

it("runs a listen-first health probe", async () => {
  const testListen = vi.fn(async () => ({
    createdSession: true,
    inCall: true,
    manualAction: undefined,
    listenVerified: true,
    listenTimedOut: false,
    captioning: true,
    captionsEnabledAttempted: true,
    transcriptLines: 1,
    lastCaptionAt: undefined,
    lastCaptionSpeaker: undefined,
    lastCaptionText: undefined,
    recentTranscript: [],
    session: {
      ...session,
      id: "meet_1",
      mode: "transcribe" as const,
      realtime: { enabled: false, provider: "openai", toolPolicy: "safe-read-only" },
    },
  }));

  await runCli(
    {
      runtime: { testListen },
    },
    ["test-listen", MEET_URL, "--transport", "chrome-node", "--timeout-ms", "30000"],
  );
  expect(testListen).toHaveBeenCalledWith({
    url: MEET_URL,
    transport: "chrome-node",
    timeoutMs: 30000,
  });
  cli.expectFields(cli.parseStdoutJson(stdout), {
    listenVerified: true,
    transcriptLines: 1,
  });
});

it("rejects a non-decimal listen timeout before runtime delegation", async () => {
  const timeoutMs = "0x10";
  const testListen = vi.fn();

  await expect(
    cli
      .setupCli({
        runtime: { testListen },
      })
      .parseAsync(["googlemeet", "test-listen", MEET_URL, "--timeout-ms", timeoutMs], {
        from: "user",
      }),
  ).rejects.toThrow("timeout-ms must be a positive number");

  expect(testListen).not.toHaveBeenCalled();
});

it("rejects a non-positive auth callback timeout", async () => {
  const timeoutSec = "0";
  await expect(
    cli
      .setupCli({})
      .parseAsync(
        ["googlemeet", "auth", "login", "--client-id", "client-id", "--timeout-sec", timeoutSec],
        { from: "user" },
      ),
  ).rejects.toThrow("timeout-sec must be a positive number");
});
