import { createHmac } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { normalizeVoiceCallConfig } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createTestStorePath,
  createVoiceCallStateRuntimeForTests,
  registerTestManagerCleanup,
} from "./manager.test-harness.js";
import type { guardedJsonApiRequest } from "./providers/shared/guarded-json-api.js";
import { TwilioProvider } from "./providers/twilio.js";
import { VoiceCallWebhookServer } from "./webhook.js";

type CarrierRequest = Parameters<typeof guardedJsonApiRequest>[0];
const mocks = vi.hoisted(() => ({
  api: vi.fn<(request: CarrierRequest) => Promise<unknown>>(),
  generate: vi.fn(),
}));
// mock-isolation: Replace external carrier HTTP and model inference. Signature
// verification, webhook handling, call management, storage, and TwiML stay real.
vi.mock("./providers/shared/guarded-json-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers/shared/guarded-json-api.js")>()),
  guardedJsonApiRequest: mocks.api,
}));
vi.mock("./response-generator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./response-generator.js")>()),
  generateVoiceResponse: mocks.generate,
}));

beforeEach(() => {
  mocks.api.mockReset().mockResolvedValue({ sid: "CA-fallback", status: "queued" });
  mocks.generate.mockReset().mockResolvedValue({ text: "I can hear you.", deliveredEarly: false });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

async function fixture(direction: "inbound" | "outbound" = "outbound") {
  const publicUrl = "https://voice.example.test/voice/webhook";
  const authToken = "synthetic-twilio-test-token";
  const config = normalizeVoiceCallConfig({
    enabled: true,
    provider: "twilio",
    fromNumber: "+15550000000",
    inboundPolicy: "open",
    inboundGreeting: "Hello & welcome.",
    streaming: { enabled: false },
  });
  const manager = registerTestManagerCleanup(
    new CallManager(
      config,
      createTestStorePath(),
      undefined,
      createVoiceCallStateRuntimeForTests(),
    ),
  );
  const provider = new TwilioProvider({ accountSid: "AC-test", authToken }, { publicUrl });
  await manager.initialize(provider, publicUrl);
  const server = new VoiceCallWebhookServer(
    createTestPluginServiceScheduler(),
    config,
    manager,
    provider,
    {},
    {} as never,
  );
  onTestFinished(() => server.stop());
  const greeting = vi.spyOn(manager, "speakInitialMessage");
  const released = Promise.withResolvers<void>();
  const createGuard = manager.createAutoResponseGuard.bind(manager);
  vi.spyOn(manager, "createAutoResponseGuard").mockImplementation((call) => {
    const guard = createGuard(call);
    return {
      ...guard,
      release() {
        guard.release();
        released.resolve();
      },
    };
  });
  let url = publicUrl;
  if (direction === "outbound") {
    const started = await manager.initiateCall("+15550000001", undefined, {
      mode: "conversation",
      message: "Hello & welcome.",
    });
    expect(started.success).toBe(true);
    url += `?callId=${started.callId}`;
  }
  const post = async (target: string, fields: Record<string, string> = {}, signature?: string) => {
    const body = new URLSearchParams({
      CallSid: "CA-fallback",
      Direction: direction === "outbound" ? "outbound-api" : "inbound",
      CallStatus: "in-progress",
      From: "+15550000001",
      To: "+15550000000",
      ...fields,
    });
    let material = target;
    for (const [key, value] of [...body].toSorted(([a], [b]) => a.localeCompare(b))) {
      material += key + value;
    }
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.url = new URL(target).pathname + new URL(target).search;
    req.headers = {
      host: "voice.example.test",
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature":
        signature ?? createHmac("sha1", authToken).update(material).digest("base64"),
    };
    req.push(body.toString());
    req.push(null);
    const res = new ServerResponse(req);
    const end = vi.spyOn(res, "end").mockReturnValue(res);
    // Exercise the HTTP handler without binding a socket or sending network traffic.
    await server["handleRequest"](req, res, config.serve.path);
    return { status: res.statusCode, body: String(end.mock.calls[0]?.[0]) };
  };
  const updates = () =>
    mocks.api.mock.calls.flatMap(([input]) => {
      const twiml = input.body instanceof URLSearchParams ? input.body.get("Twiml") : undefined;
      return twiml ? [twiml] : [];
    });
  const answer = async () => {
    expect((await post(url)).status).toBe(200);
    await Promise.all(greeting.mock.results.map((result) => result.value));
  };
  return { manager, post, url, answer, updates, released };
}

function listening(xml: string) {
  const gather = xml.match(/<Gather\b([^>]*)>/)?.[1];
  expect(gather).toContain('input="speech"');
  expect(gather).toContain('timeout="120"');
  expect(gather).toContain('method="POST"');
  expect(xml).toMatch(/<\/Gather>\s*<Redirect method="POST">([^<]+)<\/Redirect>/);
  expect(xml).not.toMatch(/<Pause|<Hangup/);
  const target = xml.match(/<Redirect method="POST">([^<]+)<\/Redirect>/)?.[1];
  expect(target).toBeDefined();
  return String(target).replaceAll("&amp;", "&");
}

it.each(["inbound", "outbound"] as const)(
  "does not replace the %s greeting Say with a second live update",
  async (direction) => {
    const f = await fixture(direction);
    await f.answer();
    expect(f.updates()).toHaveLength(1);
    expect(f.updates()[0]).toMatch(/<Say[^>]*>Hello &amp; welcome\.<\/Say>\s*<Gather/);
    listening(f.updates()[0]!);
    expect(f.manager.getActiveCalls()[0]?.state).toBe("listening");
  },
);

it("renews silent gathers and delivers the next reply through the signed webhook", async () => {
  const f = await fixture();
  await f.answer();
  const call = f.manager.getActiveCalls()[0]!;
  expect(
    await f.manager.speak(call.callId, "Take your time.", { listenAfterPlayback: true }),
  ).toEqual({ success: true });
  let redirect = listening(f.updates().at(-1)!);
  const beforeSilence = f.updates().length;
  for (let i = 0; i < 2; i++) {
    // Real silence callbacks can have identical form fields. Each returned
    // redirect must avoid being mistaken for a replay of the previous callback.
    const response = await f.post(redirect);
    expect(response.status).toBe(200);
    const next = listening(response.body);
    expect(next).not.toBe(redirect);
    redirect = next;
    expect(response.body).not.toContain("<Say");
    expect(f.updates()).toHaveLength(beforeSilence);
  }
  expect(await f.post(redirect, { SpeechResult: "Untrusted input." }, "invalid")).toEqual({
    status: 401,
    body: "Unauthorized",
  });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect((await f.post(redirect, { SpeechResult: "Hello again." })).status).toBe(200);
  await f.released.promise;
  expect(mocks.generate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ userMessage: "Hello again." }),
  );
  expect(f.updates().at(-1)).toMatch(/<Say[^>]*>I can hear you\.<\/Say>\s*<Gather/);
  listening(f.updates().at(-1)!);
  expect(
    f.manager.getCall(call.callId)?.transcript.map(({ speaker, text }) => ({ speaker, text })),
  ).toEqual([
    { speaker: "bot", text: "Hello & welcome." },
    { speaker: "bot", text: "Take your time." },
    { speaker: "user", text: "Hello again." },
    { speaker: "bot", text: "I can hear you." },
  ]);
});

it("keeps an explicit conversation prompt playing and resolves its token-scoped reply after silence", async () => {
  const f = await fixture();
  await f.answer();
  const call = f.manager.getActiveCalls()[0]!;
  const ready = Promise.withResolvers<void>();
  f.manager.onCallUpdated = (snapshot) => {
    if (snapshot.state === "listening" && snapshot.transcript.at(-1)?.text === "What next?") {
      ready.resolve();
    }
  };
  const before = f.updates().length;
  const turn = f.manager.continueCall(call.callId, "What next?");
  await ready.promise;
  const prompt = f.updates().at(-1)!;
  expect(prompt).toMatch(/<Say[^>]*>What next\?<\/Say>\s*<Gather/);
  const redirect = listening(prompt);
  const token = new URL(redirect).searchParams.get("turnToken");
  expect(token).toBeTruthy();
  const silent = await f.post(redirect);
  expect(silent.status).toBe(200);
  const next = listening(silent.body);
  expect(new URL(next).searchParams.get("turnToken")).toBe(token);
  expect((await f.post(next, { SpeechResult: "Keep going." })).status).toBe(200);
  expect(await turn).toEqual({ success: true, transcript: "Keep going." });
  expect(f.updates()).toHaveLength(before + 1);
  expect(mocks.generate).not.toHaveBeenCalled();
});
