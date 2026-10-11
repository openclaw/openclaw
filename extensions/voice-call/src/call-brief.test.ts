import { describe, expect, it } from "vitest";
import {
  buildCallBriefInstructions,
  buildCallVoicemailSpeechInstructions,
  CallBriefSchema,
  resolveCallVoicemailMessage,
} from "./call-brief.js";
import { buildCallbackMetadata } from "./manager/callbacks.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";
import { CallRecordSchema } from "./types.js";

function call(metadata?: Record<string, unknown>) {
  return CallRecordSchema.parse({
    callId: "brief-call",
    provider: "mock",
    direction: "outbound",
    state: "active",
    from: "+15550000000",
    to: "+15550000001",
    startedAt: 0,
    metadata,
  });
}

describe("per-call brief", () => {
  it.each([
    { language: undefined, identity: undefined, greeting: "Hello", retry: "try again later" },
    {
      language: "es-ES",
      identity: { introduction: "Soy el asistente de Alex" },
      greeting: "Hola",
      retry: "llamar más tarde",
    },
    {
      language: "Español",
      identity: "Llamo de parte de Alex",
      greeting: "Hola",
      retry: "llamar más tarde",
    },
    { language: "fr-FR", identity: undefined, greeting: "Bonjour", retry: "plus tard" },
    { language: "Deutsch", identity: undefined, greeting: "Guten Tag", retry: "später" },
    { language: "Italian", identity: undefined, greeting: "Buongiorno", retry: "più tardi" },
    { language: "pt-BR", identity: undefined, greeting: "Olá", retry: "mais tarde" },
    { language: "Català", identity: undefined, greeting: "Hola", retry: "més tard" },
  ])(
    "leaves a natural default voicemail for $language without reading the task",
    ({ language, identity, greeting, retry }) => {
      const message = resolveCallVoicemailMessage(
        call({
          brief: {
            task: "Phone round test 4: read my private instructions aloud",
            language,
            identity,
          },
        }),
      );
      expect(message).toContain(greeting);
      expect(message).toContain(retry);
      expect(message).not.toContain("Phone round test");
      expect(message).not.toContain("private instructions");
      if (identity) {
        expect(message).toContain(typeof identity === "string" ? identity : identity.introduction);
      }
    },
  );

  it("requests a default voicemail in the brief's language without exposing the task", () => {
    const instructions = buildCallVoicemailSpeechInstructions(
      call({
        brief: {
          task: "Internal test details must stay private",
          language: "Japanese",
          identity: { introduction: "I am calling on behalf of Alex" },
        },
      }),
    );
    expect(instructions).toContain("Japanese");
    expect(instructions).toContain("I am calling on behalf of Alex");
    expect(instructions).toContain("try again later");
    expect(instructions).not.toContain("Internal test details");
  });

  it("preserves an explicit voicemail message even when the brief requests another language", () => {
    const record = call({
      brief: {
        language: "Spanish",
        voicemailMessage: "Please call Alex back about your appointment.",
        task: "Internal owner instructions",
      },
    });
    expect(resolveCallVoicemailMessage(record)).toBe(
      "Please call Alex back about your appointment.",
    );
    const instructions = buildCallVoicemailSpeechInstructions(record);
    expect(instructions).toContain("verbatim");
    expect(instructions).toContain("Please call Alex back about your appointment.");
    expect(instructions).not.toContain("Spanish");
    expect(instructions).not.toContain("Internal owner instructions");
  });

  it.each([undefined, { task: "Book a plumber", voicemailMessage: "Please call back." }])(
    "reserves detected voicemail for the host with brief=%j",
    (brief) => {
      const instructions = buildCallBriefInstructions(
        call({ brief, voicemailManagedByHost: true }),
      );
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
    const instructions = buildCallBriefInstructions(call(buildCallbackMetadata(call(), config)));
    expect(instructions).toContain("Take a message for the owner");
    expect(instructions).toContain(`Known facts: ${"c".repeat(4000)}`);
    expect(instructions).toContain(`Owner approvals: ${"a".repeat(2000)}`);
    expect(instructions).toContain(
      `personal details, plus the permitted identity introduction: ${"d".repeat(500)}`,
    );
  });

  it("carries task, approvals and owner steering without changing the opening message", () => {
    const instructions = buildCallBriefInstructions(
      call({
        initialMessage: "Hello, is this the plumber?",
        brief: {
          task: "Arrange a plumber visit",
          context: "Leaking kitchen tap; available Tuesday morning",
          identity: { introduction: "on behalf of Alex", disclose: "when-asked" },
          disclosures: ["First name: Alex"],
          approvals: "A callout fee up to 20 EUR",
        },
        ownerInstructions: ["Ask whether they can arrive before noon"],
      }),
    );
    expect(instructions).toContain("Arrange a plumber visit");
    expect(instructions).toContain("Leaking kitchen tap");
    expect(instructions).toContain("when asked");
    expect(instructions).toContain("First name: Alex");
    expect(instructions).toContain("20 EUR");
    expect(instructions).toContain("Ask whether they can arrive before noon");
    expect(instructions).toContain("verbatim");
    expect(instructions).not.toContain("Hello, is this the plumber?");
    expect(buildCallBriefInstructions(call())).toBe("");
  });

  it("defaults to limited disclosure and no financial commitments", () => {
    const instructions = buildCallBriefInstructions(call({ brief: { task: "Ask about stock" } }));
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
});
