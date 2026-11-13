import { expect, it, vi } from "vitest";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import { runPublicMessageActionsScenario } from "./scenario-runtime-message-actions.js";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
// mock-isolation: Only room-state inspection is exercised; no live homeserver or Gateway is used.
vi.mock("../substrate/request.js", () => ({ requestMatrixJson: mocks.request }));

it.each([
  { version: "12", creator: "@sut:matrix-qa.test", power: 0, allowed: true },
  { version: "12", creator: "@other:matrix-qa.test", power: 0, allowed: false },
  { version: "11", creator: "@sut:matrix-qa.test", power: 0, allowed: false },
  { version: "11", creator: "@sut:matrix-qa.test", power: 100, allowed: true },
])(
  "checks actual room permission for $version/$creator/$power",
  async ({ version, creator, power, allowed }) => {
    const context = createMatrixQaE2eeTestContext({ sutAccountId: "sut" });
    context.topology.rooms.push({
      key: "public-actions",
      kind: "group",
      name: "actions",
      encrypted: false,
      roomId: context.roomId,
      memberRoles: ["sut", "observer"],
      memberUserIds: [context.sutUserId, context.observerUserId],
      requireMention: false,
    });
    mocks.request.mockImplementation(async ({ endpoint }: { endpoint: string }) => ({
      body: endpoint.endsWith("/state")
        ? [
            {
              type: "m.room.create",
              state_key: "",
              sender: creator,
              content: { room_version: version },
            },
          ]
        : endpoint.endsWith("/sync")
          ? { next_batch: "test-sync-cursor" }
          : { users: power === 0 ? {} : { [context.sutUserId]: power }, state_default: 50 },
    }));
    const stopped = new Error("permission checked; stop before live action");
    const gateway = vi.fn(async () => {
      throw stopped;
    });
    context.gatewayCall = gateway;
    const error = await runPublicMessageActionsScenario(context).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    if (allowed) {
      expect(error).toHaveProperty("cause", stopped);
      expect(gateway).toHaveBeenCalledOnce();
    } else {
      expect(error).toHaveProperty(
        "cause.message",
        "SUT must already have permission to set the room's pinned events",
      );
      expect(gateway).not.toHaveBeenCalled();
    }
  },
);
