import { describe, expect, it } from "vitest";
import { projectSlackTokenRevocation } from "./token-revocations.js";

const envelope = {
  type: "event_callback",
  api_app_id: "A123",
  team_id: "T123",
  event_id: "EvREVOCATION1",
  event_time: 1_700_000_000,
  token: "synthetic-verification-secret",
  event: {
    type: "tokens_revoked",
    tokens: { oauth: ["U222", "U111", "U222"], bot: ["U333"] },
    text: "synthetic-private-message",
  },
};

describe("Slack revocation metadata projection", () => {
  it("keeps only canonical OAuth-user metadata and original identity/time", () => {
    expect(projectSlackTokenRevocation(envelope)).toEqual({
      appId: "A123",
      workspaceId: "T123",
      eventId: "EvREVOCATION1",
      eventTime: 1_700_000_000,
      oauthUserIds: ["U111", "U222"],
    });
  });

  it("does not emit messages or private/DM content", () => {
    for (const channel_type of ["channel", "group", "im", "mpim"]) {
      expect(
        projectSlackTokenRevocation({
          ...envelope,
          event: { type: "message", channel_type, text: "synthetic-private-message" },
        }),
      ).toBeNull();
    }
  });

  it("treats bot-only revocation as an empty OAuth list", () => {
    expect(
      projectSlackTokenRevocation({
        ...envelope,
        event: { type: "tokens_revoked", tokens: { bot: ["U333"] } },
      })?.oauthUserIds,
    ).toEqual([]);
  });

  it.each([
    { ...envelope, type: "slack_event" },
    { ...envelope, api_app_id: "wrong-app" },
    { ...envelope, team_id: "wrong-team" },
    { ...envelope, event_id: "wrong-event" },
    { ...envelope, event_time: -1 },
    { ...envelope, event_time: Number.MAX_SAFE_INTEGER + 1 },
    { ...envelope, event: { type: "tokens_revoked" } },
    { ...envelope, event: { type: "tokens_revoked", tokens: null } },
    { ...envelope, event: { type: "tokens_revoked", tokens: "invalid-container" } },
    {
      ...envelope,
      event: { type: "tokens_revoked", tokens: { oauth: ["synthetic-token-value"] } },
    },
    { ...envelope, event: { type: "tokens_revoked", tokens: { oauth: Array(101).fill("U123") } } },
  ])("rejects malformed or oversized metadata without consumer delivery", (body) => {
    expect(() => projectSlackTokenRevocation(body)).toThrow(
      "Invalid Slack token revocation metadata",
    );
  });

  it("accepts the maximum bounded list without truncation", () => {
    const oauth = Array.from({ length: 100 }, (_, i) => `U${i}`);
    expect(
      projectSlackTokenRevocation({
        ...envelope,
        event: { type: "tokens_revoked", tokens: { oauth } },
      })?.oauthUserIds,
    ).toHaveLength(100);
  });
});
