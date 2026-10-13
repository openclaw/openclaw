import { describe, expect, it } from "vitest";
import { resolveModelCallUrgency } from "./run-trigger.js";

describe("resolveModelCallUrgency", () => {
  it.each([
    ["channel request", { currentInboundEventKind: "user_request" }],
    ["external user", { inputProvenance: { kind: "external_user" } }],
    ["direct CLI or gateway user", { trigger: "user" }],
  ] as const)("classifies %s as foreground", (_name, provenance) => {
    expect(resolveModelCallUrgency(provenance)).toBe("foreground");
  });

  it.each([
    ["unclassified request", {}],
    ["room event", { currentInboundEventKind: "room_event", trigger: "event" }],
    ["inter-session input", { trigger: "user", inputProvenance: { kind: "inter_session" } }],
    ["internal input", { trigger: "user", inputProvenance: { kind: "internal_system" } }],
    ["spawned work", { trigger: "user", spawnedBy: "agent:parent:main" }],
    ["trusted handoff", { trigger: "user", trustedInternalHandoff: true }],
  ] as const)("keeps %s at normal urgency", (_name, provenance) => {
    expect(resolveModelCallUrgency(provenance)).toBe("normal");
  });

  it.each([
    ["cron trigger", { trigger: "cron" }],
    ["heartbeat trigger", { trigger: "heartbeat" }],
    ["memory trigger", { trigger: "memory" }],
    ["cron bootstrap", { bootstrapContextRunKind: "cron" }],
    ["heartbeat bootstrap", { bootstrapContextRunKind: "heartbeat" }],
  ] as const)(
    "keeps %s behind interactive work despite inherited user provenance",
    (_name, provenance) => {
      expect(
        resolveModelCallUrgency({
          trigger: "user",
          currentInboundEventKind: "user_request",
          inputProvenance: { kind: "external_user" },
          spawnedBy: "agent:parent:main",
          ...provenance,
        }),
      ).toBe("background");
    },
  );
});
