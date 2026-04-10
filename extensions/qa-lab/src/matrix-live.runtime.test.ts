import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { __testing } from "./matrix-driver-client.js";
import { __testing as liveTesting } from "./matrix-live.runtime.js";

describe("matrix live qa runtime", () => {
  it("injects a temporary Matrix account into the QA gateway config", () => {
    const baseCfg: OpenClawConfig = {
      plugins: {
        allow: ["memory-core", "qa-channel"],
        entries: {
          "memory-core": { enabled: true },
          "qa-channel": { enabled: true },
        },
      },
    };

    const next = liveTesting.buildMatrixQaConfig(baseCfg, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      roomId: "!room:matrix-qa.test",
      sutAccessToken: "syt_sut",
      sutAccountId: "sut",
      sutDeviceId: "DEVICE123",
      sutUserId: "@sut:matrix-qa.test",
    });

    expect(next.plugins?.allow).toContain("matrix");
    expect(next.plugins?.entries?.matrix).toEqual({ enabled: true });
    expect(next.channels?.matrix).toEqual({
      enabled: true,
      defaultAccount: "sut",
      accounts: {
        sut: {
          accessToken: "syt_sut",
          deviceId: "DEVICE123",
          dm: { enabled: false },
          enabled: true,
          encryption: false,
          groupAllowFrom: ["@driver:matrix-qa.test"],
          groupPolicy: "allowlist",
          groups: {
            "!room:matrix-qa.test": {
              enabled: true,
              requireMention: true,
            },
          },
          homeserver: "http://127.0.0.1:28008/",
          network: {
            dangerouslyAllowPrivateNetwork: true,
          },
          replyToMode: "off",
          threadReplies: "inbound",
          userId: "@sut:matrix-qa.test",
        },
      },
    });
  });

  it("redacts Matrix observed event content by default in artifacts", () => {
    expect(
      liveTesting.buildObservedEventsArtifact({
        includeContent: false,
        observedEvents: [
          {
            roomId: "!room:matrix-qa.test",
            eventId: "$event",
            sender: "@sut:matrix-qa.test",
            type: "m.room.message",
            body: "secret",
            formattedBody: "<p>secret</p>",
            msgtype: "m.text",
            originServerTs: 1_700_000_000_000,
            relatesTo: {
              relType: "m.thread",
              eventId: "$root",
              inReplyToId: "$driver",
              isFallingBack: true,
            },
          },
        ],
      }),
    ).toEqual([
      {
        roomId: "!room:matrix-qa.test",
        eventId: "$event",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        msgtype: "m.text",
        originServerTs: 1_700_000_000_000,
        relatesTo: {
          relType: "m.thread",
          eventId: "$root",
          inReplyToId: "$driver",
          isFallingBack: true,
        },
      },
    ]);
  });

  it("fails when any requested Matrix scenario id is unknown", () => {
    expect(() => liveTesting.findScenario(["matrix-thread-follow-up", "typo-scenario"])).toThrow(
      "unknown Matrix QA scenario id(s): typo-scenario",
    );
  });
});

describe("matrix driver client", () => {
  it("normalizes message events with thread metadata", () => {
    expect(
      __testing.normalizeMatrixQaObservedEvent("!room:matrix-qa.test", {
        event_id: "$event",
        sender: "@sut:matrix-qa.test",
        type: "m.room.message",
        origin_server_ts: 1_700_000_000_000,
        content: {
          body: "hello",
          msgtype: "m.text",
          "m.mentions": {
            user_ids: ["@sut:matrix-qa.test"],
          },
          "m.relates_to": {
            rel_type: "m.thread",
            event_id: "$root",
            is_falling_back: true,
            "m.in_reply_to": {
              event_id: "$driver",
            },
          },
        },
      }),
    ).toEqual({
      roomId: "!room:matrix-qa.test",
      eventId: "$event",
      sender: "@sut:matrix-qa.test",
      type: "m.room.message",
      originServerTs: 1_700_000_000_000,
      body: "hello",
      msgtype: "m.text",
      relatesTo: {
        relType: "m.thread",
        eventId: "$root",
        inReplyToId: "$driver",
        isFallingBack: true,
      },
      mentions: {
        userIds: ["@sut:matrix-qa.test"],
      },
    });
  });

  it("advances Matrix registration through token then dummy auth stages", () => {
    const firstStage = __testing.resolveNextRegistrationAuth({
      registrationToken: "reg-token",
      response: {
        session: "uiaa-session",
        flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
      },
    });

    expect(firstStage).toEqual({
      session: "uiaa-session",
      type: "m.login.registration_token",
      token: "reg-token",
    });

    expect(
      __testing.resolveNextRegistrationAuth({
        registrationToken: "reg-token",
        response: {
          session: "uiaa-session",
          completed: ["m.login.registration_token"],
          flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
        },
      }),
    ).toEqual({
      session: "uiaa-session",
      type: "m.login.dummy",
    });
  });
});
