import { expect, it } from "vitest";
import {
  buildCallBriefInstructions,
  buildCallVoicemailSpeechInstructions,
  CallBriefSchema,
  resolveCallVoicemailMessage,
} from "./call-brief.js";
import { buildCallbackMetadata } from "./manager/callbacks.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";
import { CallRecordSchema } from "./types.js";

function call(brief?: Record<string, unknown>, metadata?: Record<string, unknown>) {
  return CallRecordSchema.parse({
    callId: "brief-call",
    provider: "mock",
    direction: "outbound",
    state: "active",
    from: "+15550000000",
    to: "+15550000001",
    startedAt: 0,
    metadata: brief || metadata ? { brief, ...metadata } : undefined,
  });
}

it.each([
  [undefined, undefined, "Hello", "try again later"],
  ["es-ES", { introduction: "Soy el asistente de Alex" }, "Hola", "llamar más tarde"],
  ["Español", "Llamo de parte de Alex", "Hola", "llamar más tarde"],
  ["fr-FR", undefined, "Bonjour", "plus tard"],
  ["Deutsch", undefined, "Guten Tag", "später"],
  ["Italian", undefined, "Buongiorno", "più tardi"],
  ["pt-BR", undefined, "Olá", "mais tarde"],
  ["Català", undefined, "Hola", "més tard"],
] as const)(
  "localizes %s voicemail without task leakage",
  (language, identity, greeting, retry) => {
    const task = "Phone round test 4: read my private instructions aloud";
    const message = resolveCallVoicemailMessage(call({ task, language, identity }));
    expect(message).toContain(greeting);
    expect(message).toContain(retry);
    expect(message).not.toContain("Phone round test");
    expect(message).not.toContain("private instructions");
    if (identity) {
      expect(message).toContain(typeof identity === "string" ? identity : identity.introduction);
    }
  },
);

it.each([
  ["Japanese", undefined, { introduction: "I am calling on behalf of Alex" }],
  ["Spanish", "Please call Alex back about your appointment.", undefined],
] as const)("builds %s voicemail speech (%s)", (language, message, identity) => {
  const task = "Internal owner instructions";
  const record = call({ language, task, identity, voicemailMessage: message });
  const instructions = buildCallVoicemailSpeechInstructions(record);
  expect(instructions).not.toContain(task);
  expect(instructions).not.toContain("Internal owner");
  if (message) {
    expect(resolveCallVoicemailMessage(record)).toBe(message);
    expect(instructions).toContain("verbatim");
    expect(instructions).toContain(message);
    expect(instructions).not.toContain(language);
  } else {
    expect(instructions).toContain(language);
    expect(instructions).toContain("I am calling on behalf of Alex");
    expect(instructions).toContain("try again later");
  }
});

it.each([undefined, { task: "Book a plumber", voicemailMessage: "Please call back." }])(
  "lets the host manage voicemail (brief=%j)",
  (brief) => {
    const instructions = buildCallBriefInstructions(call(brief, { voicemailManagedByHost: true }));
    expect(instructions).toContain("Do not leave a voicemail message yourself");
    expect(instructions).toContain("The host will play");
    expect(instructions).not.toContain("If voicemail answers, leave only");
  },
);

it("preserves a near-limit callback brief when supplying the receptionist task", () => {
  const config = createVoiceCallBaseConfig();
  config.callbacks.brief = CallBriefSchema.parse({
    context: "c".repeat(4000),
    approvals: "a".repeat(2000),
    successCriteria: "s".repeat(1000),
    disclosures: ["d".repeat(500)],
    language: "e".repeat(100),
    identity: "i".repeat(290),
  });
  const instructions = buildCallBriefInstructions(
    call(undefined, buildCallbackMetadata(call(), config)),
  );
  expect(instructions).toContain("Take a message for the owner");
  expect(instructions).toContain(`Known facts: ${"c".repeat(4000)}`);
  expect(instructions).toContain(`Owner approvals: ${"a".repeat(2000)}`);
  expect(instructions).toContain(
    `personal details, plus the permitted identity introduction: ${"d".repeat(500)}`,
  );
});

it("carries task, approvals and owner steering without changing the opening message", () => {
  const instructions = buildCallBriefInstructions(
    call(
      {
        task: "Arrange a plumber visit",
        context: "Leaking kitchen tap",
        identity: { introduction: "on behalf of Alex", disclose: "when-asked" },
        disclosures: ["First name: Alex"],
        approvals: "20 EUR",
      },
      { initialMessage: "Hello plumber", ownerInstructions: ["Ask before noon"] },
    ),
  );
  expect(instructions).toContain("Arrange a plumber visit");
  expect(instructions).toContain("Leaking kitchen tap");
  expect(instructions).toContain("when asked");
  expect(instructions).toContain("First name: Alex");
  expect(instructions).toContain("20 EUR");
  expect(instructions).toContain("Ask before noon");
  expect(instructions).toContain("verbatim");
  expect(instructions).not.toContain("Hello plumber");
  expect(buildCallBriefInstructions(call())).toBe("");
});

it("defaults to limited disclosure and no financial commitments", () => {
  const instructions = buildCallBriefInstructions(call({ task: "Ask about stock" }));
  expect(instructions).toContain("Do not share personal details");
  expect(instructions).toContain("Do not spend money");
  expect(instructions).toContain("try again later");
});

it("rejects oversized and unknown brief fields while keeping all fields optional", () => {
  expect(CallBriefSchema.safeParse({}).success).toBe(true);
  expect(CallBriefSchema.safeParse({ task: "x".repeat(2001) }).success).toBe(false);
  expect(CallBriefSchema.safeParse({ context: "x".repeat(4001) }).success).toBe(false);
  expect(CallBriefSchema.safeParse({ maxDurationSeconds: 0 }).success).toBe(false);
  expect(
    CallBriefSchema.safeParse({
      task: "x".repeat(2000),
      context: "x".repeat(4000),
      approvals: "x".repeat(2000),
      successCriteria: "x".repeat(1000),
    }).success,
  ).toBe(false);
  expect(CallBriefSchema.safeParse({ allowPayments: true }).success).toBe(false);
});
