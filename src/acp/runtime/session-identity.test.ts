import { describe, expect, it } from "vitest";
import { createIdentityFromEnsure } from "./session-identity.js";

describe("createIdentityFromEnsure", () => {
  it("marks ensured sessions resolved when stable session ids already exist", () => {
    const identity = createIdentityFromEnsure({
      handle: {
        sessionKey: "agent:codex:acp:session-1",
        backend: "acpx",
        runtimeSessionName: "runtime-1",
        backendSessionId: "acpx-1",
        agentSessionId: "codex-inner-1",
      },
      now: 123,
    });

    expect(identity).toEqual({
      state: "resolved",
      source: "ensure",
      acpxSessionId: "acpx-1",
      agentSessionId: "codex-inner-1",
      lastUpdatedAt: 123,
    });
  });

  it("keeps record-only ensure identities pending", () => {
    const identity = createIdentityFromEnsure({
      handle: {
        sessionKey: "agent:codex:acp:session-2",
        backend: "acpx",
        runtimeSessionName: "runtime-2",
        acpxRecordId: "rec-1",
      } as {
        sessionKey: string;
        backend: string;
        runtimeSessionName: string;
        acpxRecordId: string;
      },
      now: 456,
    });

    expect(identity).toEqual({
      state: "pending",
      source: "ensure",
      acpxRecordId: "rec-1",
      lastUpdatedAt: 456,
    });
  });
});
