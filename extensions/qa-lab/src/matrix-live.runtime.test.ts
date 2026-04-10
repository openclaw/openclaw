import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, provisionMatrixQaRoom } from "./matrix-driver-client.js";
import { __testing as liveTesting } from "./matrix-live.runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("matrix live qa runtime", () => {
  it("ships both Matrix live QA scenarios by default", () => {
    expect(liveTesting.findScenario().map((scenario) => scenario.id)).toEqual([
      "matrix-thread-follow-up",
      "matrix-thread-isolation",
    ]);
  });

  it("uses the repo-wide exact marker prompt shape for Matrix canaries", () => {
    expect(liveTesting.buildMentionPrompt("@sut:matrix-qa.test", "MATRIX_QA_CANARY_TOKEN")).toBe(
      "@sut:matrix-qa.test reply with only this exact marker: MATRIX_QA_CANARY_TOKEN",
    );
  });

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

  it("treats only connected, healthy Matrix accounts as ready", () => {
    expect(liveTesting.isMatrixAccountReady({ running: true, connected: true })).toBe(true);
    expect(liveTesting.isMatrixAccountReady({ running: true, connected: false })).toBe(false);
    expect(
      liveTesting.isMatrixAccountReady({
        running: true,
        connected: true,
        restartPending: true,
      }),
    ).toBe(false);
    expect(
      liveTesting.isMatrixAccountReady({
        running: true,
        connected: true,
        healthState: "degraded",
      }),
    ).toBe(false);
  });

  it("waits past not-ready Matrix status snapshots until the account is really ready", async () => {
    vi.useFakeTimers();
    const gateway = {
      call: vi
        .fn()
        .mockResolvedValueOnce({
          channelAccounts: {
            matrix: [{ accountId: "sut", running: true, connected: false }],
          },
        })
        .mockResolvedValueOnce({
          channelAccounts: {
            matrix: [{ accountId: "sut", running: true, connected: true }],
          },
        }),
    };

    const waitPromise = liveTesting.waitForMatrixChannelReady(gateway as never, "sut", {
      timeoutMs: 1_000,
      pollMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(waitPromise).resolves.toBeUndefined();
    expect(gateway.call).toHaveBeenCalledTimes(2);
  });

  it("fails readiness when the Matrix account never reaches a healthy connected state", async () => {
    vi.useFakeTimers();
    const gateway = {
      call: vi.fn().mockResolvedValue({
        channelAccounts: {
          matrix: [{ accountId: "sut", running: true, connected: true, healthState: "degraded" }],
        },
      }),
    };

    const waitPromise = liveTesting.waitForMatrixChannelReady(gateway as never, "sut", {
      timeoutMs: 250,
      pollMs: 100,
    });
    const expectation = expect(waitPromise).rejects.toThrow(
      'matrix account "sut" did not become ready',
    );
    await vi.advanceTimersByTimeAsync(300);
    await expectation;
  });
});

describe("matrix driver client", () => {
  it("builds Matrix HTML mentions for QA driver messages", () => {
    expect(
      __testing.buildMatrixQaMessageContent({
        body: "@sut:matrix-qa.test reply with exactly: TOKEN",
        mentionUserIds: ["@sut:matrix-qa.test"],
      }),
    ).toEqual({
      body: "@sut:matrix-qa.test reply with exactly: TOKEN",
      msgtype: "m.text",
      format: "org.matrix.custom.html",
      formatted_body:
        '<a href="https://matrix.to/#/%40sut%3Amatrix-qa.test">@sut:matrix-qa.test</a> reply with exactly: TOKEN',
      "m.mentions": {
        user_ids: ["@sut:matrix-qa.test"],
      },
    });
  });

  it("omits Matrix HTML markup when the body has no visible mention token", () => {
    expect(
      __testing.buildMatrixQaMessageContent({
        body: "reply with exactly: TOKEN",
        mentionUserIds: ["@sut:matrix-qa.test"],
      }),
    ).toEqual({
      body: "reply with exactly: TOKEN",
      msgtype: "m.text",
      "m.mentions": {
        user_ids: ["@sut:matrix-qa.test"],
      },
    });
  });

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

  it("provisions a three-member room so Matrix QA runs in a group context", async () => {
    const createRoomBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (url.endsWith("/_matrix/client/v3/register")) {
        const username = typeof body.username === "string" ? body.username : "";
        const auth = typeof body.auth === "object" && body.auth ? body.auth : undefined;
        if (!auth) {
          return new Response(
            JSON.stringify({
              session: `session-${username}`,
              flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        if ((auth as { type?: string }).type === "m.login.registration_token") {
          return new Response(
            JSON.stringify({
              session: `session-${username}`,
              completed: ["m.login.registration_token"],
              flows: [{ stages: ["m.login.registration_token", "m.login.dummy"] }],
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            access_token: `token-${username}`,
            device_id: `device-${username}`,
            user_id: `@${username}:matrix-qa.test`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/_matrix/client/v3/createRoom")) {
        createRoomBodies.push(body);
        return new Response(JSON.stringify({ room_id: "!room:matrix-qa.test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/_matrix/client/v3/join/")) {
        return new Response(JSON.stringify({ room_id: "!room:matrix-qa.test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const result = await provisionMatrixQaRoom({
      baseUrl: "http://127.0.0.1:28008/",
      driverLocalpart: "qa-driver",
      observerLocalpart: "qa-observer",
      registrationToken: "reg-token",
      roomName: "OpenClaw Matrix QA",
      sutLocalpart: "qa-sut",
      fetchImpl,
    });

    expect(result.roomId).toBe("!room:matrix-qa.test");
    expect(result.observer.userId).toBe("@qa-observer:matrix-qa.test");
    expect(createRoomBodies).toEqual([
      expect.objectContaining({
        invite: ["@qa-sut:matrix-qa.test", "@qa-observer:matrix-qa.test"],
        is_direct: false,
        preset: "private_chat",
      }),
    ]);
  });
});
