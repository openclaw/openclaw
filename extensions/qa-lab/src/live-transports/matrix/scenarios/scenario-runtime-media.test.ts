import { afterEach, describe, expect, it, vi } from "vitest";

const primeMatrixQaDriverScenarioClient = vi.hoisted(() => vi.fn());

vi.mock("./scenario-runtime-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-runtime-shared.js")>()),
  primeMatrixQaDriverScenarioClient,
}));

import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import { runGeneratedImageDeliveryScenario, testing } from "./scenario-runtime-media.js";
import type {
  createMatrixQaScenarioClient,
  MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";

it("accepts punctuation differences in the voice preflight marker", () => {
  expect(
    testing.hasMatrixQaVoicePreflightReply(
      '📝 "C3PLQA reply with only these words Matrix QA voice pre-flight OK."',
    ),
  ).toBe(true);
});

const roomId = "!media:matrix-qa.test";

function createGeneratedImageContext(
  observedEvents: MatrixQaScenarioContext["observedEvents"] = [],
) {
  return createMatrixQaE2eeTestContext({
    observedEvents,
    roomId,
    timeoutMs: 180_000,
    topology: {
      defaultRoomId: roomId,
      defaultRoomKey: "media",
      rooms: [
        {
          key: "media",
          kind: "group",
          memberRoles: [],
          memberUserIds: [],
          name: "media",
          requireMention: true,
          roomId,
        },
      ],
    },
  });
}

const eventBase = {
  kind: "message" as const,
  type: "m.room.message",
  roomId,
  sender: "@sut:matrix-qa.test",
};

function primeGeneratedImageClient(
  waitForOptionalRoomEvent: ReturnType<
    typeof createMatrixQaScenarioClient
  >["waitForOptionalRoomEvent"],
) {
  const sendTextMessage = vi.fn(async () => "$driver-trigger");
  primeMatrixQaDriverScenarioClient.mockResolvedValue({
    client: { sendTextMessage, waitForOptionalRoomEvent },
    startSince: "start",
  });
  return sendTextMessage;
}

describe("Matrix generated image delivery", () => {
  afterEach(() => vi.clearAllMocks());

  it("sends one trigger and accepts one fresh top-level image", async () => {
    const waitForOptionalRoomEvent = vi.fn(async ({ predicate }) => {
      const event = {
        ...eventBase,
        eventId: "$generated-image",
        attachment: { filename: "generated.png", kind: "image" as const },
        msgtype: "m.image",
        originServerTs: Date.now() + 1,
      };
      expect(predicate(event)).toBe(true);
      return { event, matched: true as const, since: "next" };
    });
    const sendTextMessage = primeGeneratedImageClient(waitForOptionalRoomEvent);

    const result = await runGeneratedImageDeliveryScenario(createGeneratedImageContext());

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(waitForOptionalRoomEvent).toHaveBeenCalledTimes(1);
    expect(result.details).toContain("driver event: $driver-trigger");
    expect(result.details).toContain("generated image event: $generated-image");
  });

  it("bounds timeout diagnostics to the last eight room events", async () => {
    const observedEvents = Array.from({ length: 10 }, (_, index) => ({
      ...eventBase,
      eventId: `$event-${index + 1}`,
      body: `event body ${index + 1}`,
    }));
    observedEvents.push({
      ...eventBase,
      eventId: "$other-room",
      roomId: "!other:matrix-qa.test",
      body: "other room",
    });
    const sendTextMessage = primeGeneratedImageClient(
      vi.fn(async () => ({ matched: false as const, since: "next" })),
    );

    const error = await runGeneratedImageDeliveryScenario(
      createGeneratedImageContext(observedEvents),
    ).catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(message).toContain("$event-3");
    expect(message).toContain("$event-10");
    expect(message).not.toContain('$event-1"');
    expect(message).not.toContain('$event-2"');
    expect(message).not.toContain("$other-room");
  });
});
