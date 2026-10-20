import { afterEach, describe, expect, it, vi } from "vitest";
import { mockMatrixQaHttp } from "../substrate/http.test-support.js";
import {
  runAllowBotsMentionsDmUnmentionedScenario,
  runAllowBotsMentionsMentionedRoomScenario,
  runAllowBotsRoomOverrideEnablesAccountOffScenario,
  runAllowBotsTrueUnmentionedOpenRoomScenario,
} from "./scenario-runtime-allowbots.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import { runMatrixQaCanary } from "./scenario-runtime-thread.js";

afterEach(() => vi.restoreAllMocks());

describe("Matrix top-level scenario artifacts", () => {
  it.each([
    ["canary", "CANARY", true],
    ["observer", "ALLOWBOTS_MENTIONS_MENTIONED", true],
    ["unmentioned", "ALLOWBOTS_TRUE_OPEN", false],
    ["dm", "ALLOWBOTS_MENTIONS_DM", false],
    ["override", "ALLOWBOTS_ROOM_ENABLE", true],
  ] as const)(
    "keeps %s report fields independent of transport observation state",
    async (scenario, tokenPrefix, withMention) => {
      const context = createMatrixQaE2eeTestContext();
      const roomKey = scenario === "dm" ? "bot-dm" : "main";
      const roomId = scenario === "dm" ? "!dm:matrix-qa.test" : context.roomId;
      context.topology.rooms.push({
        key: roomKey,
        kind: scenario === "dm" ? "dm" : "group",
        memberRoles: ["driver", "observer", "sut"],
        memberUserIds: [context.driverUserId, context.observerUserId, context.sutUserId],
        name: "QA report fixture",
        requireMention: true,
        roomId,
      });
      const actorId = scenario === "canary" ? "driver" : "observer";
      let marker = "";
      let triggerBody = "";
      mockMatrixQaHttp(async (input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${context[`${actorId}AccessToken`]}`,
        );
        const url = new URL(input instanceof Request ? input.url : input);
        if (init?.method === "PUT") {
          expect(decodeURIComponent(url.pathname)).toContain(`/rooms/${roomId}/send/`);
          const content = (await new Response(init.body).json()) as {
            body: string;
            "m.mentions"?: { user_ids: string[] };
          };
          expect(content["m.mentions"]).toEqual(
            withMention ? { user_ids: [context.sutUserId] } : undefined,
          );
          triggerBody = content.body;
          marker = triggerBody.split("exact marker: ")[1] ?? "";
          expect(marker).toMatch(new RegExp(`^MATRIX_QA_${tokenPrefix}_[A-F0-9]+$`));
          return Response.json({ event_id: "$trigger" });
        }
        if (!url.searchParams.has("since")) {
          return Response.json({ next_batch: "primed" });
        }
        return Response.json({
          next_batch: "replied",
          rooms: {
            join: {
              [roomId]: {
                timeline: {
                  events: [
                    {
                      event_id: "$reply",
                      sender: context.sutUserId,
                      type: "m.room.message",
                      content: { body: marker, msgtype: "m.text" },
                    },
                  ],
                },
              },
            },
          },
        });
      });
      const result =
        scenario === "canary"
          ? await runMatrixQaCanary(context)
          : (
              await {
                observer: runAllowBotsMentionsMentionedRoomScenario,
                unmentioned: runAllowBotsTrueUnmentionedOpenRoomScenario,
                dm: runAllowBotsMentionsDmUnmentionedScenario,
                override: runAllowBotsRoomOverrideEnablesAccountOffScenario,
              }[scenario](context)
            ).artifacts;
      const reply = {
        bodyPreview: marker,
        eventId: "$reply",
        mentions: undefined,
        relatesTo: undefined,
        sender: context.sutUserId,
        tokenMatched: true,
      };
      expect(result).toEqual({
        ...(scenario === "canary"
          ? { body: triggerBody }
          : { actorUserId: context.observerUserId, roomKey, triggerBody }),
        driverEventId: "$trigger",
        reply,
        token: marker,
      });
    },
  );
});
