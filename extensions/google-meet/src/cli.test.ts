import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
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

let stdout: ReturnType<typeof cli.captureStdout>;
const run = (args: string[], params: Parameters<typeof cli.setupCli>[0] = {}) =>
  cli.setupCli(params).parseAsync(["googlemeet", ...args], { from: "user" });
beforeEach(() => {
  stdout = cli.captureStdout();
});
afterEach(() => {
  stdout.restore();
  vi.unstubAllGlobals();
});
afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

it.each([false, true])("prints local doctor output (json=%s)", async (json) => {
  const status = vi.fn<GoogleMeetRuntime["status"]>().mockResolvedValue({ found: false });
  const callGatewayFromCli = vi.fn(async () => {
    throw Object.assign(new Error("gateway closed"), {
      name: "GatewayTransportError",
      kind: "closed",
      connectionDetails: { url: "ws://127.0.0.1:18789" },
    });
  });
  await run(["doctor", "meet_missing", ...(json ? ["--json"] : [])], {
    runtime: { status },
    callGatewayFromCli,
  });
  if (json) {
    expect(cli.parseStdoutJson(stdout)).toEqual({ found: false });
  } else {
    expect(stdout.output()).toBe("Google Meet session: not found\n");
  }
  expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith(
    "googlemeet.status",
    { json: true, timeout: "5000" },
    { sessionId: "meet_missing" },
    { progress: false },
  );
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
  expect(stdout.output()).toBe("");
});

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
  expect(stdout.output().split("\n")).toEqual(expect.arrayContaining(lines));
  if (name === "Twilio") {
    expect(stdout.output()).not.toContain("audio input active:");
  }
});

it("can prove Google Meet API create access", async () => {
  const responses: Record<string, unknown> = {
    "https://oauth2.googleapis.com/token": {
      access_token: "new-access-token",
      expires_in: 3600,
      token_type: "Bearer",
    },
    "https://meet.googleapis.com/v2/spaces": {
      name: "spaces/new-space",
      meetingUri: "https://meet.google.com/new-abcd-xyz",
    },
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const response = responses[cli.requestUrl(input).href];
    return response ? cli.jsonResponse(response) : new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  await run(["doctor", "--oauth", "--create-space", "--json"], {
    config: {
      oauth: { clientId: "client-id", clientSecret: "client-secret", refreshToken: "rt-secret" },
    },
  });
  for (const secret of ["new-access-token", "rt-secret", "client-secret"]) {
    expect(stdout.output()).not.toContain(secret);
  }
  expect(cli.parseStdoutJson(stdout)).toMatchObject({
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
  expect(stdout.output()).toContain("Google Meet current tab: found");
  expect(stdout.output()).toContain("target: tab-1");
  expect(stdout.output()).toContain("manual reason: meet-admission-required");
});
