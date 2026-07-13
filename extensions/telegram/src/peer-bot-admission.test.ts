import { describe, expect, it, vi } from "vitest";
import { createTelegramPeerBotAdmissionCoordinator } from "./peer-bot-admission.js";

describe("createTelegramPeerBotAdmissionCoordinator", () => {
  it("forwards no-cache cleanup through a reservation", async () => {
    const coordinator = createTelegramPeerBotAdmissionCoordinator();
    const check = vi.fn(async () => false);
    const admission = coordinator.reserve("peer", check);

    await expect(admission(false, false)).resolves.toBe(false);
    expect(check).toHaveBeenCalledWith(false, false);
  });
});
