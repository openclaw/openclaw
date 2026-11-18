import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatrixQaRoomEvent } from "../substrate/events.js";
import { mockMatrixQaHttp } from "../substrate/http.test-support.js";
import {
  runAllowBotsMentionsDmUnmentionedScenario,
  runAllowBotsMentionsMentionedRoomScenario,
  runAllowBotsTrueUnmentionedOpenRoomScenario,
} from "./scenario-runtime-allowbots.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import { runGeneratedImageDeliveryScenario, testing } from "./scenario-runtime-media.js";
import { runMatrixQaCanary } from "./scenario-runtime-thread.js";
import { matrixMessage, matrixSyncResponse } from "./scenario-runtime.test-support.js";

afterEach(() => vi.restoreAllMocks());

function createRoomContext(key: string) {
  const context = createMatrixQaE2eeTestContext();
  context.topology.rooms.push({
    key,
    kind: key === "bot-dm" ? "dm" : "group",
    memberRoles: [],
    memberUserIds: [],
    name: key,
    requireMention: true,
    roomId: key === "bot-dm" ? "!dm:matrix-qa.test" : context.roomId,
  });
  return context;
}

describe("Matrix top-level scenario reporting", () => {
  it.each([
    ["canary", "CANARY", true],
    ["observer", "ALLOWBOTS_MENTIONS_MENTIONED", true],
    ["unmentioned", "ALLOWBOTS_TRUE_OPEN", false],
    ["dm", "ALLOWBOTS_MENTIONS_DM", false],
  ] as const)(
    "keeps %s report fields independent of transport observation state",
    async (scenario, tokenPrefix, withMention) => {
      const context = createRoomContext(scenario === "dm" ? "bot-dm" : "main");
      const roomId = scenario === "dm" ? "!dm:matrix-qa.test" : context.roomId;
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
        return matrixSyncResponse(
          roomId,
          [matrixMessage("$reply", marker, context.sutUserId, "m.text")],
          "replied",
        );
      });
      if (scenario === "canary") {
        const result = await runMatrixQaCanary(context);
        expect(result.driverEventId).toBe("$trigger");
        expect(result.reply).toMatchObject({ eventId: "$reply", tokenMatched: true });
      } else {
        const result = await {
          observer: runAllowBotsMentionsMentionedRoomScenario,
          unmentioned: runAllowBotsTrueUnmentionedOpenRoomScenario,
          dm: runAllowBotsMentionsDmUnmentionedScenario,
        }[scenario](context);
        expect(result.details).toContain("driver event: $trigger");
        expect(result.details).toContain("reply event: $reply");
        expect(result.details).toContain("reply token matched: yes");
      }
    },
  );
});

it("accepts punctuation differences in the voice preflight marker", () => {
  expect(
    testing.hasMatrixQaVoicePreflightReply(
      '📝 "C3PLQA reply with only these words Matrix QA voice pre-flight OK."',
    ),
  ).toBe(true);
});

const imageContext = () => createRoomContext("media");
const eventBase = {
  kind: "message" as const,
  type: "m.room.message",
  roomId: "!room:matrix-qa.test",
  sender: "@sut:matrix-qa.test",
};
function mockImageClient(events: MatrixQaRoomEvent[] = []) {
  const sends: unknown[] = [];
  mockMatrixQaHttp(async (input, init) => {
    if (init?.method === "PUT") {
      sends.push(init.body);
      return Response.json({ event_id: "$driver-trigger" });
    }
    const url = new URL(input instanceof Request ? input.url : input);
    return matrixSyncResponse(eventBase.roomId, url.searchParams.has("since") ? events : []);
  });
  return sends;
}

it("sends one trigger and accepts one fresh top-level image", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const sends = mockImageClient([
    {
      ...matrixMessage("$generated-image", "generated.png", eventBase.sender, "m.image"),
      origin_server_ts: 1_000,
    },
  ]);
  const result = await runGeneratedImageDeliveryScenario(imageContext());
  expect(sends).toHaveLength(1);
  expect(result.details).toContain("driver event: $driver-trigger");
  expect(result.details).toContain("generated image event: $generated-image");
});

it("bounds timeout diagnostics to eight room events with UTF-16-safe previews", async () => {
  const context = imageContext();
  const previewPrefix = "a".repeat(199);
  context.observedEvents = Array.from({ length: 10 }, (_, index) => ({
    ...eventBase,
    eventId: `$event-${index + 1}`,
    body: index === 9 ? `${previewPrefix}😀tail` : `event body ${index + 1}`,
  }));
  context.observedEvents.push({
    ...eventBase,
    eventId: "$other-room",
    roomId: "!other:matrix-qa.test",
    body: "other room",
  });
  const sends = mockImageClient();
  const error = await runGeneratedImageDeliveryScenario({ ...context, timeoutMs: 0 }).catch(
    (cause: unknown) => cause,
  );
  const message = error instanceof Error ? error.message : String(error);
  expect(sends).toHaveLength(1);
  expect(message).toContain("$event-3");
  expect(message).toContain("$event-10");
  expect(message).toContain(`"body":"${previewPrefix}"`);
  expect(message).not.toContain('$event-1"');
  expect(message).not.toContain('$event-2"');
  expect(message).not.toContain("$other-room");
});
