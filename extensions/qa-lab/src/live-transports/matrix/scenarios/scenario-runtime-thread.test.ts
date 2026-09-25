import { afterEach, describe, expect, it, vi } from "vitest";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import {
  runMatrixQaCanary,
  runObserverAllowlistOverrideScenario,
} from "./scenario-runtime-thread.js";

afterEach(() => vi.unstubAllGlobals());

describe("Matrix top-level scenario artifacts", () => {
  it.each(["canary", "observer"] as const)(
    "keeps %s report fields independent of transport observation state",
    async (scenario) => {
      const context = createMatrixQaE2eeTestContext();
      const actorId = scenario === "canary" ? "driver" : "observer";
      let marker = "";
      let triggerBody = "";
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${context[`${actorId}AccessToken`]}`,
        );
        const url = new URL(input instanceof Request ? input.url : input);
        if (init?.method === "PUT") {
          const content = (await new Response(init.body).json()) as { body: string };
          triggerBody = content.body;
          marker = triggerBody.split("exact marker: ")[1] ?? "";
          expect(marker).toMatch(/^MATRIX_QA_(?:CANARY|OBSERVER_ALLOWLIST)_[A-F0-9]+$/);
          return Response.json({ event_id: "$trigger" });
        }
        if (!url.searchParams.has("since")) {
          return Response.json({ next_batch: "primed" });
        }
        return Response.json({
          next_batch: "replied",
          rooms: {
            join: {
              [context.roomId]: {
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
          : (await runObserverAllowlistOverrideScenario(context)).artifacts;
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
          : { actorUserId: context.observerUserId, triggerBody }),
        driverEventId: "$trigger",
        reply,
        token: marker,
      });
      expect(context.syncState).toEqual({ [actorId]: "replied" });
    },
  );
});
