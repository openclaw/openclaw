import { afterEach, expect, it, vi } from "vitest";
import type { GoogleMeetRuntime } from "./runtime.js";
import * as cli from "./test-support/cli-harness.js";
import { MEET_URL, meetSession } from "./test-support/fixtures.test-helpers.js";
import type { GoogleMeetSession } from "./transports/types.js";

const doctorSession = {
  ...meetSession(),
  chrome: undefined,
  transport: "chrome-node",
  realtime: { enabled: true, provider: "openai", toolPolicy: "safe-read-only" },
} satisfies GoogleMeetSession;
const health = {
  captioning: true,
  transcriptLines: 2,
  lastCaptionSpeaker: "Alice",
  lastCaptionText: "Can everyone hear OpenClaw?",
  providerConnected: true,
  audioInputActive: true,
  audioOutputActive: false,
};

const { run, output, json } = cli.useCli();

afterEach(() => vi.unstubAllEnvs());

it.each([false, true])("prints local doctor output (json=%s)", async (asJson) => {
  const status = vi.fn<GoogleMeetRuntime["status"]>().mockResolvedValue({ found: false });
  await run(["doctor", "meet_missing", ...(asJson ? ["--json"] : [])], { runtime: { status } });
  if (asJson) {
    expect(json()).toEqual({ found: false });
  } else {
    expect(output()).toBe("Google Meet session: not found\n");
  }
  expect(status.mock.calls).toEqual([["meet_missing"]]);
});

it("preserves the original gateway doctor error without output", async () => {
  const error = new Error("gateway failed");
  await expect(
    run(["doctor", "meet_missing"], {
      runtime: { status: vi.fn().mockRejectedValue(error) },
      callGatewayFromCli: vi.fn().mockRejectedValue(error),
    }),
  ).rejects.toBe(error);
  expect(output()).toBe("");
});

it.each([
  { command: "resolve-space", explicit: true, json: false },
  { command: "resolve-space", explicit: false, json: true },
  { command: "preflight", explicit: true, json: true },
  { command: "preflight", explicit: false, json: false },
])(
  "resolves $command (explicit=$explicit, json=$json)",
  async ({ command, explicit, json: asJson }) => {
    const meeting = explicit ? "spaces/explicit" : "spaces/configured";
    const space = { name: meeting, meetingCode: "abc-defg-hij" };
    const fetchMock = vi.fn(async () => cli.jsonResponse(space));
    vi.stubGlobal("fetch", fetchMock);
    await run(
      [
        command,
        ...(explicit ? ["--meeting", "  spaces/explicit  "] : []),
        ...(asJson ? ["--json"] : []),
      ],
      {
        config: {
          defaults: { meeting: "spaces/configured" },
          oauth: { accessToken: "fixture-token", expiresAt: Date.now() + 3_600_000 },
        },
      },
    );
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `https://meet.googleapis.com/v2/${meeting}`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer fixture-token" }),
      }),
    );
    if (asJson) {
      expect(json()).toMatchObject(
        command === "resolve-space" ? space : { input: meeting, resolvedSpaceName: meeting },
      );
    } else {
      expect(output()).toContain(`input: ${meeting}\n`);
      expect(output()).toContain("meeting code: abc-defg-hij\n");
      expect(output()).toContain("token source: cached-access-token\n");
    }
  },
);

it.each(["resolve-space", "preflight"])(
  "rejects missing %s meeting before OAuth",
  async (command) => {
    vi.stubEnv("OPENCLAW_GOOGLE_MEET_DEFAULT_MEETING", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(run([command])).rejects.toThrow(
      "Meeting input is required. Pass a URL/meeting code or configure defaults.meeting.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(output()).toBe("");
  },
);

it.each([
  {
    name: "Chrome",
    session: {
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        nodeId: "node-1",
        audioBridge: { type: "node-command-pair", provider: "openai" },
        health,
      },
    } satisfies Partial<GoogleMeetSession>,
    lines: [
      "session: meet_1",
      "node: node-1",
      "provider connected: yes",
      "captioning: yes",
      "transcript lines: 2",
      "last caption text: Alice: Can everyone hear OpenClaw?",
      "audio input active: yes",
      "audio output active: no",
    ],
  },
  {
    name: "Twilio",
    session: {
      transport: "twilio",
      twilio: {
        dialInNumber: "+15551234567",
        pinProvided: true,
        voiceCallId: "call-1",
        dtmfSent: true,
        introSent: true,
      },
    } satisfies Partial<GoogleMeetSession>,
    lines: [
      "session: meet_1",
      "transport: twilio",
      "twilio dial-in: +15551234567",
      "voice call id: call-1",
      "dtmf sent: yes",
      "intro sent: yes",
    ],
  },
])("prints $name session doctor output", async ({ name, session, lines }) => {
  await run(["doctor", "meet_1"], {
    runtime: { status: async () => ({ found: true, session: { ...doctorSession, ...session } }) },
  });
  expect(output().split("\n")).toEqual(expect.arrayContaining(lines));
  if (name === "Twilio") {
    expect(output()).not.toContain("audio input active:");
  }
});

it("can prove Google Meet API create access", async () => {
  const fetchMock = cli.stubJsonRoutes({
    "https://oauth2.googleapis.com/token": {
      access_token: "new-access-token",
      expires_in: 3600,
      token_type: "Bearer",
    },
    "https://meet.googleapis.com/v2/spaces": {
      name: "spaces/new-space",
      meetingUri: "https://meet.google.com/new-abcd-xyz",
    },
  });
  await run(["doctor", "--oauth", "--create-space", "--json"], {
    config: {
      oauth: { clientId: "client-id", clientSecret: "client-secret", refreshToken: "rt-secret" },
    },
  });
  for (const secret of ["new-access-token", "rt-secret", "client-secret"]) {
    expect(output()).not.toContain(secret);
  }
  expect(json()).toMatchObject({
    ok: true,
    tokenSource: "refresh-token",
    createdSpace: "spaces/new-space",
    meetingUri: "https://meet.google.com/new-abcd-xyz",
    checks: [
      { id: "oauth-config", ok: true },
      { id: "oauth-token", ok: true },
      { id: "meet-spaces-create", ok: true },
    ],
  });
  expect(fetchMock).toHaveBeenCalledWith("https://meet.googleapis.com/v2/spaces", {
    method: "POST",
    body: "{}",
    headers: {
      Authorization: "Bearer new-access-token",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
});

it("recovers and summarizes an existing Meet tab", async () => {
  const message = "Admit the OpenClaw browser participant in Google Meet.";
  await run(["recover-tab"], {
    config: { defaultTransport: "chrome-node" },
    runtime: {
      recoverCurrentTab: async () => ({
        transport: "chrome-node",
        nodeId: "node-1",
        found: true,
        targetId: "tab-1",
        tab: { targetId: "tab-1", url: MEET_URL },
        browser: {
          inCall: false,
          manualAction: { reason: "meet-admission-required", message },
          browserUrl: MEET_URL,
        },
        message,
      }),
    },
  });
  cli.expectText(
    output(),
    "Google Meet current tab: found",
    "target: tab-1",
    "manual reason: meet-admission-required",
  );
});

const session = meetSession({ id: "meet_gateway", transport: "chrome-node" });
const runSetup = (ok: boolean, id: string, message: string, args: string[]) =>
  run(args, { runtime: { setupStatus: async () => ({ ok, checks: [{ id, ok, message }] }) } });

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
  const parsed = run([command, "meet_1", ...(command === "speak" ? ["hello meeting"] : [])], {
    ensureRuntime,
    callGatewayFromCli,
  });
  if (expected instanceof Error) {
    await expect(parsed).rejects.toEqual(expected);
  } else {
    await parsed;
  }
  expect(output()).toBe(expected instanceof Error ? "" : expected);
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
  await runSetup(true, "audio-bridge", "audio ready", ["setup"]);
  expect(output()).toContain("Google Meet setup: OK");
  expect(output()).toContain("[ok] audio-bridge: audio ready");
  expect(output()).not.toContain('"checks"');

  await runSetup(false, "twilio-voice-call-plugin", "missing", ["setup", "--json"]);
  expect(json()).toMatchObject({
    ok: false,
    checks: [{ id: "twilio-voice-call-plugin", ok: false }],
  });
  expect(process.exitCode).toBe(1);
});

it.each([
  ["mode", "agnt", "agent, bidi, transcribe, or realtime"],
  ["transport", "definitely-not-a-transport", "chrome, chrome-node, or twilio"],
])("rejects unknown setup %s values", async (option, value, allowed) => {
  const setupStatus = vi.fn<NonNullable<GoogleMeetRuntime["setupStatus"]>>();
  await expect(run(["setup", `--${option}`, value], { runtime: { setupStatus } })).rejects.toThrow(
    `${option} must be ${allowed}; received ${value}`,
  );
  expect(setupStatus).not.toHaveBeenCalled();
});

it("accepts --json on session status", async () => {
  const sessions = [
    meetSession({ transport: "twilio", participantIdentity: "Twilio PSTN participant" }),
  ];
  await run(["status", "--json"], { runtime: { status: async () => ({ found: true, sessions }) } });
  expect(json()).toMatchObject({
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

  await run(["transcript", "meet_gateway", "--since", "3"], { callGatewayFromCli });
  expect(callGatewayFromCli).toHaveBeenCalledWith(
    "googlemeet.transcript",
    { json: true, timeout: "5000" },
    { sessionId: "meet_gateway", sinceIndex: 3 },
    { progress: false },
  );
  cli.expectText(
    output(),
    "# 2 earlier lines dropped by the transcript cap",
    "Alice: fourth line",
    "# nextIndex: 4",
  );
});

it("rejects invalid transcript cursors before gateway delegation", async () => {
  const callGatewayFromCli = vi.fn();
  await expect(
    run(["transcript", "meet_gateway", "--since", "9007199254740992"], { callGatewayFromCli }),
  ).rejects.toThrow("--since must be a non-negative safe integer");
  expect(callGatewayFromCli).not.toHaveBeenCalled();
});

it.each([
  ["join", "chrome-node", "realtime", { id: "meet_gateway", transport: "chrome-node" }],
  ["test-speech", "chrome", "bidi", { createdSession: true, session: { mode: "bidi" } }],
] as const)(
  "delegates %s to the gateway-owned runtime",
  async (command, transport, mode, expected) => {
    const joined = { ...session, transport, mode };
    const result = {
      session: joined,
      ...(command === "test-speech" ? { createdSession: true } : {}),
    };
    const callGatewayFromCli = vi.fn(async () => result);
    const ensureRuntime = vi.fn(async () => {
      throw new Error("local runtime should not be loaded");
    });
    await run(
      [command, MEET_URL, "--transport", transport, "--mode", mode, "--message", "Hello meeting"],
      { callGatewayFromCli, ensureRuntime },
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      command === "join" ? "googlemeet.join" : "googlemeet.testSpeech",
      { json: true, timeout: "60000" },
      {
        url: MEET_URL,
        transport,
        mode,
        message: "Hello meeting",
        ...(command === "join"
          ? { dialInNumber: undefined, pin: undefined, dtmfSequence: undefined }
          : {}),
      },
      { progress: false },
    );
    expect(ensureRuntime).not.toHaveBeenCalled();
    expect(json()).toMatchObject(expected);
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
    session: meetSession({
      transport: "chrome-node",
      mode: "transcribe",
      realtime: { enabled: false, provider: "openai", toolPolicy: "safe-read-only" },
    }),
  }));

  await run(["test-listen", MEET_URL, "--transport", "chrome-node", "--timeout-ms", "30000"], {
    runtime: { testListen },
  });
  expect(testListen).toHaveBeenCalledWith({
    url: MEET_URL,
    transport: "chrome-node",
    timeoutMs: 30000,
  });
  expect(json()).toMatchObject({ listenVerified: true, transcriptLines: 1 });
});

it("rejects a non-decimal listen timeout before runtime delegation", async () => {
  const testListen = vi.fn();
  await expect(
    run(["test-listen", MEET_URL, "--timeout-ms", "0x10"], { runtime: { testListen } }),
  ).rejects.toThrow("timeout-ms must be a positive number");

  expect(testListen).not.toHaveBeenCalled();
});

it("rejects a non-positive auth callback timeout", async () => {
  await expect(
    run(["auth", "login", "--client-id", "client-id", "--timeout-sec", "0"]),
  ).rejects.toThrow("timeout-sec must be a positive number");
});
