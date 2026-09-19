import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleMeetRuntime } from "./runtime.js";
import {
  captureStdout,
  expectFields,
  firstRecord,
  parseStdoutJson,
  setupCli,
} from "./test-support/cli-harness.js";
import { meetSession } from "./test-support/fixtures.test-helpers.js";

describe("google-meet CLI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.exitCode = undefined;
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  describe.each(["gateway", "local"] as const)("lifecycle results through %s", (route) => {
    const cases: Array<{
      command: "leave" | "speak";
      name: string;
      result: Awaited<ReturnType<GoogleMeetRuntime["speak"]>> & { browserLeft?: boolean };
      output?: string;
      error?: string;
    }> = [
      {
        command: "leave",
        name: "missing session",
        result: { found: false, spoken: false },
        error: "session not found",
      },
      {
        command: "leave",
        name: "completed",
        result: { found: true, spoken: false },
        output: "left meet_1\n",
      },
      {
        command: "leave",
        name: "browser still present",
        result: { found: true, spoken: false, browserLeft: false },
        output:
          "left meet_1, but the browser participant may still be in the call; check session notes\n",
      },
      {
        command: "speak",
        name: "missing session takes precedence over blocked speech",
        result: {
          found: false,
          spoken: false,
          session: meetSession({ chrome: { health: { speechBlockedMessage: "blocked" } } }),
        },
        error: "session not found",
      },
      {
        command: "speak",
        name: "explicit blocked message",
        result: {
          found: true,
          spoken: false,
          session: meetSession({
            chrome: { health: { speechBlockedMessage: "microphone muted" } },
          }),
        },
        error: "microphone muted",
      },
      {
        command: "speak",
        name: "empty blocked message",
        result: {
          found: true,
          spoken: false,
          session: meetSession({ chrome: { health: { speechBlockedMessage: "" } } }),
        },
        error: "",
      },
      {
        command: "speak",
        name: "missing blocked message",
        result: { found: true, spoken: false },
        error: "session has no active realtime audio bridge",
      },
      {
        command: "speak",
        name: "completed",
        result: { found: true, spoken: true },
        output: "speaking on meet_1\n",
      },
    ];

    it.each(cases)("$command: $name", async ({ command, result, output, error }) => {
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
        NonNullable<Parameters<typeof setupCli>[0]["callGatewayFromCli"]>
      >(async () => {
        calls.push("gateway");
        if (route === "local") {
          throw Object.assign(new Error(`unknown method: googlemeet.${command}`), {
            name: "GatewayClientRequestError",
            gatewayCode: "INVALID_REQUEST",
            retryable: false,
          });
        }
        return result;
      });
      const stdout = captureStdout();
      try {
        const args = ["googlemeet", command, "meet_1"];
        if (command === "speak") {
          args.push("hello meeting");
        }
        const parsed = setupCli({ callGatewayFromCli, ensureRuntime }).parseAsync(args, {
          from: "user",
        });
        if (error !== undefined) {
          await expect(parsed).rejects.toEqual(new Error(error));
        } else {
          await parsed;
        }
        expect(stdout.output()).toBe(output ?? "");
        expect(calls).toEqual(route === "local" ? ["gateway", "runtime", command] : ["gateway"]);
        expect(callGatewayFromCli).toHaveBeenCalledWith(
          `googlemeet.${command}`,
          { json: true, timeout: "5000" },
          { sessionId: "meet_1", ...(command === "speak" ? { message: "hello meeting" } : {}) },
          { progress: false },
        );
        expect(leave.mock.calls).toEqual(
          route === "local" && command === "leave" ? [["meet_1"]] : [],
        );
        expect(speak.mock.calls).toEqual(
          route === "local" && command === "speak" ? [["meet_1", "hello meeting"]] : [],
        );
      } finally {
        stdout.restore();
      }
    });
  });

  it("prints setup checks as text and JSON", async () => {
    {
      const stdout = captureStdout();
      try {
        await setupCli({
          runtime: {
            setupStatus: async () => ({
              ok: true,
              checks: [
                {
                  id: "audio-bridge",
                  ok: true,
                  message: "Chrome command-pair talk-back audio bridge configured (pcm16-24khz)",
                },
              ],
            }),
          },
        }).parseAsync(["googlemeet", "setup"], { from: "user" });
        expect(stdout.output()).toContain("Google Meet setup: OK");
        expect(stdout.output()).toContain(
          "[ok] audio-bridge: Chrome command-pair talk-back audio bridge configured (pcm16-24khz)",
        );
        expect(stdout.output()).not.toContain('"checks"');
      } finally {
        stdout.restore();
      }
    }

    {
      const stdout = captureStdout();
      try {
        await setupCli({
          runtime: {
            setupStatus: async () => ({
              ok: false,
              checks: [{ id: "twilio-voice-call-plugin", ok: false, message: "missing" }],
            }),
          },
        }).parseAsync(["googlemeet", "setup", "--json"], { from: "user" });
        const payload = parseStdoutJson(stdout);
        expectFields(payload, { ok: false });
        expectFields(firstRecord(payload.checks), {
          id: "twilio-voice-call-plugin",
          ok: false,
        });
        expect(process.exitCode).toBe(1);
      } finally {
        stdout.restore();
      }
    }
  });

  it("rejects unknown setup mode and transport values", async () => {
    const setupStatus = vi.fn<NonNullable<GoogleMeetRuntime["setupStatus"]>>();
    const cli = setupCli({ runtime: { setupStatus } });

    await expect(
      cli.parseAsync(["googlemeet", "setup", "--mode", "agnt"], { from: "user" }),
    ).rejects.toThrow("mode must be agent, bidi, transcribe, or realtime; received agnt");
    await expect(
      cli.parseAsync(["googlemeet", "setup", "--transport", "definitely-not-a-transport"], {
        from: "user",
      }),
    ).rejects.toThrow(
      "transport must be chrome, chrome-node, or twilio; received definitely-not-a-transport",
    );
    expect(setupStatus).not.toHaveBeenCalled();
  });

  it("accepts --json on session status", async () => {
    const stdout = captureStdout();
    try {
      await setupCli({
        runtime: {
          status: async () => ({
            found: true,
            sessions: [
              {
                id: "meet_1",
                url: "https://meet.google.com/abc-defg-hij",
                state: "active",
                transport: "twilio",
                mode: "agent",
                agentId: "main",
                participantIdentity: "Twilio PSTN participant",
                createdAt: "2026-04-25T00:00:00.000Z",
                updatedAt: "2026-04-25T00:00:01.000Z",
                realtime: { enabled: true, provider: "openai", toolPolicy: "safe-read-only" },
                notes: [],
              },
            ],
          }),
        },
      }).parseAsync(["googlemeet", "status", "--json"], { from: "user" });
      const payload = parseStdoutJson(stdout);
      expectFields(payload, { found: true });
      expectFields(firstRecord(payload.sessions), {
        id: "meet_1",
        transport: "twilio",
      });
    } finally {
      stdout.restore();
    }
  });

  it("delegates session status to the gateway-owned runtime when available", async () => {
    const callGatewayFromCli = vi.fn(async () => ({
      found: true,
      sessions: [
        {
          id: "meet_gateway",
          url: "https://meet.google.com/abc-defg-hij",
          state: "active",
          transport: "chrome-node",
          mode: "agent",
          agentId: "main",
          participantIdentity: "signed-in Google Chrome profile on a paired node",
          createdAt: "2026-04-25T00:00:00.000Z",
          updatedAt: "2026-04-25T00:00:01.000Z",
          realtime: { enabled: true, provider: "openai", toolPolicy: "safe-read-only" },
          notes: [],
        },
      ],
    }));
    const ensureRuntime = vi.fn(async () => {
      throw new Error("local runtime should not be loaded");
    });
    const stdout = captureStdout();
    try {
      await setupCli({
        callGatewayFromCli,
        ensureRuntime: ensureRuntime as unknown as () => Promise<GoogleMeetRuntime>,
      }).parseAsync(["googlemeet", "status", "--json"], { from: "user" });
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "googlemeet.status",
        { json: true, timeout: "5000" },
        { sessionId: undefined },
        { progress: false },
      );
      expect(ensureRuntime).not.toHaveBeenCalled();
      const payload = parseStdoutJson(stdout);
      expectFields(payload, { found: true });
      expectFields(firstRecord(payload.sessions), {
        id: "meet_gateway",
        transport: "chrome-node",
      });
    } finally {
      stdout.restore();
    }
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
    const stdout = captureStdout();
    try {
      await setupCli({ callGatewayFromCli }).parseAsync(
        ["googlemeet", "transcript", "meet_gateway", "--since", "3"],
        { from: "user" },
      );
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "googlemeet.transcript",
        { json: true, timeout: "5000" },
        { sessionId: "meet_gateway", sinceIndex: 3 },
        { progress: false },
      );
      expect(stdout.output()).toContain("# 2 earlier lines dropped by the transcript cap");
      expect(stdout.output()).toContain("Alice: fourth line");
      expect(stdout.output()).toContain("# nextIndex: 4");
    } finally {
      stdout.restore();
    }
  });

  it.each([
    ["0", 0],
    ["3", 3],
    ["+3", 3],
    [" 3 ", 3],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const)("accepts base-10 safe transcript cursors: %s", async (since, expected) => {
    const callGatewayFromCli = vi.fn(async () => ({
      found: true,
      sessionId: "meet_gateway",
      startIndex: expected,
      nextIndex: expected,
      lines: [],
    }));

    await setupCli({ callGatewayFromCli }).parseAsync(
      ["googlemeet", "transcript", "meet_gateway", "--since", since],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "googlemeet.transcript",
      { json: true, timeout: "5000" },
      { sessionId: "meet_gateway", sinceIndex: expected },
      { progress: false },
    );
  });

  it.each(["", " ", "-1", "0x10", "0o10", "0b10", "1e0", "1.5", "9007199254740992"])(
    "rejects non-decimal transcript cursors before gateway delegation: %s",
    async (since) => {
      const callGatewayFromCli = vi.fn();

      await expect(
        setupCli({ callGatewayFromCli }).parseAsync(
          ["googlemeet", "transcript", "meet_gateway", "--since", since],
          { from: "user" },
        ),
      ).rejects.toThrow("--since must be a non-negative safe integer");

      expect(callGatewayFromCli).not.toHaveBeenCalled();
    },
  );

  it("delegates join to the gateway-owned runtime when available", async () => {
    const callGatewayFromCli = vi.fn(async () => ({
      session: {
        id: "meet_gateway",
        url: "https://meet.google.com/abc-defg-hij",
        state: "active",
        transport: "chrome-node",
        mode: "realtime",
        agentId: "main",
        participantIdentity: "signed-in Google Chrome profile on a paired node",
        createdAt: "2026-04-25T00:00:00.000Z",
        updatedAt: "2026-04-25T00:00:01.000Z",
        realtime: { enabled: true, provider: "openai", toolPolicy: "safe-read-only" },
        notes: [],
      },
    }));
    const ensureRuntime = vi.fn(async () => {
      throw new Error("local runtime should not be loaded");
    });
    const stdout = captureStdout();
    try {
      await setupCli({
        callGatewayFromCli,
        ensureRuntime: ensureRuntime as unknown as () => Promise<GoogleMeetRuntime>,
      }).parseAsync(
        [
          "googlemeet",
          "join",
          "https://meet.google.com/abc-defg-hij",
          "--transport",
          "chrome-node",
          "--mode",
          "realtime",
          "--message",
          "Hello meeting",
        ],
        { from: "user" },
      );
      const gatewayCall = callGatewayFromCli.mock.calls.at(0) as unknown as
        | [
            string,
            { json?: boolean; timeout?: unknown },
            Record<string, unknown>,
            { progress?: boolean },
          ]
        | undefined;
      expect(gatewayCall?.[0]).toBe("googlemeet.join");
      expect(gatewayCall?.[1]?.json).toBe(true);
      expect(typeof gatewayCall?.[1]?.timeout).toBe("string");
      expect(gatewayCall?.[1]?.timeout).not.toBe("");
      expect(gatewayCall?.[2]).toEqual({
        url: "https://meet.google.com/abc-defg-hij",
        transport: "chrome-node",
        mode: "realtime",
        message: "Hello meeting",
        dialInNumber: undefined,
        pin: undefined,
        dtmfSequence: undefined,
      });
      expect(gatewayCall?.[3]).toEqual({ progress: false });
      expect(ensureRuntime).not.toHaveBeenCalled();
      expectFields(parseStdoutJson(stdout), {
        id: "meet_gateway",
        transport: "chrome-node",
      });
    } finally {
      stdout.restore();
    }
  });

  it("delegates test speech mode to the gateway-owned runtime", async () => {
    const callGatewayFromCli = vi.fn(async () => ({
      createdSession: true,
      spoken: true,
      speechOutputVerified: true,
      speechOutputTimedOut: false,
      session: {
        id: "meet_gateway",
        url: "https://meet.google.com/abc-defg-hij",
        state: "active",
        transport: "chrome",
        mode: "bidi",
        agentId: "main",
        participantIdentity: "signed-in Google Chrome profile",
        createdAt: "2026-04-25T00:00:00.000Z",
        updatedAt: "2026-04-25T00:00:01.000Z",
        realtime: { enabled: true, strategy: "bidi", provider: "openai" },
        notes: [],
      },
    }));
    const ensureRuntime = vi.fn(async () => {
      throw new Error("local runtime should not be loaded");
    });
    const stdout = captureStdout();
    try {
      await setupCli({
        callGatewayFromCli,
        ensureRuntime: ensureRuntime as unknown as () => Promise<GoogleMeetRuntime>,
      }).parseAsync(
        [
          "googlemeet",
          "test-speech",
          "https://meet.google.com/abc-defg-hij",
          "--transport",
          "chrome",
          "--mode",
          "bidi",
          "--message",
          "Hello meeting",
        ],
        { from: "user" },
      );

      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "googlemeet.testSpeech",
        { json: true, timeout: "60000" },
        {
          url: "https://meet.google.com/abc-defg-hij",
          transport: "chrome",
          mode: "bidi",
          message: "Hello meeting",
        },
        { progress: false },
      );
      expect(ensureRuntime).not.toHaveBeenCalled();
      const payload = parseStdoutJson(stdout);
      expectFields(payload, { createdSession: true });
      expectFields(payload.session, { mode: "bidi" });
    } finally {
      stdout.restore();
    }
  });

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
        id: "meet_1",
        url: "https://meet.google.com/abc-defg-hij",
        state: "active" as const,
        transport: "chrome-node" as const,
        mode: "transcribe" as const,
        agentId: "main",
        participantIdentity: "signed-in Google Chrome profile on a paired node",
        createdAt: "2026-04-25T00:00:00.000Z",
        updatedAt: "2026-04-25T00:00:01.000Z",
        realtime: { enabled: false, provider: "openai", toolPolicy: "safe-read-only" },
        notes: [],
      },
    }));
    const stdout = captureStdout();
    try {
      await setupCli({
        runtime: { testListen },
      }).parseAsync(
        [
          "googlemeet",
          "test-listen",
          "https://meet.google.com/abc-defg-hij",
          "--transport",
          "chrome-node",
          "--timeout-ms",
          "30000",
        ],
        { from: "user" },
      );
      expect(testListen).toHaveBeenCalledWith({
        url: "https://meet.google.com/abc-defg-hij",
        transport: "chrome-node",
        timeoutMs: 30000,
      });
      expectFields(parseStdoutJson(stdout), {
        listenVerified: true,
        transcriptLines: 1,
      });
    } finally {
      stdout.restore();
    }
  });

  it.each(["0x10", "1e3"])("rejects non-decimal listen timeouts: %s", async (timeoutMs) => {
    const testListen = vi.fn();

    await expect(
      setupCli({
        runtime: { testListen },
      }).parseAsync(
        [
          "googlemeet",
          "test-listen",
          "https://meet.google.com/abc-defg-hij",
          "--timeout-ms",
          timeoutMs,
        ],
        { from: "user" },
      ),
    ).rejects.toThrow("timeout-ms must be a positive number");

    expect(testListen).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1e3"])("rejects invalid auth callback timeouts: %s", async (timeoutSec) => {
    await expect(
      setupCli({}).parseAsync(
        ["googlemeet", "auth", "login", "--client-id", "client-id", "--timeout-sec", timeoutSec],
        { from: "user" },
      ),
    ).rejects.toThrow("timeout-sec must be a positive number");
  });
});
