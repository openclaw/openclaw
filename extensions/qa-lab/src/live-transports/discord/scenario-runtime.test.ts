import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScenarioEnvironment,
  polledReply,
  sentMessage,
} from "./discord-flow.test-support.js";
import * as testing from "./discord-live.runtime.js";
import type { DiscordQaScenarioImplementation } from "./discord-live.runtime.js";
import { runDiscordScenario } from "./scenario-runtime.js";

describe("Discord QA scenario runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns structured RTT evidence for a matched reply", async () => {
    const implementation = {
      buildRun: () => ({
        kind: "channel-message",
        expectReply: true,
        input: "ping",
        expectedTextIncludes: ["pong"],
        matchText: "pong",
      }),
    } satisfies DiscordQaScenarioImplementation;
    const environment = createScenarioEnvironment({
      configureScenario: vi.fn(async () => ({ cfg: {}, run: implementation.buildRun() })),
    });
    vi.spyOn(testing, "sendChannelMessage").mockResolvedValue(
      sentMessage("523456789012345678", "2026-09-02T12:00:00.000Z"),
    );
    vi.spyOn(testing, "pollChannelMessages").mockResolvedValue(
      polledReply("623456789012345678", "pong", "2026-09-02T12:00:01.750Z"),
    );

    await expect(runDiscordScenario(environment, implementation)).resolves.toEqual({
      details: "reply matched",
      requestStartedAt: "2026-09-02T12:00:00.000Z",
      responseObservedAt: "2026-09-02T12:00:01.750Z",
      rttMs: 1750,
      rttMeasurement: {
        finalMatchedReplyRttMs: 1750,
        requestStartedAt: "2026-09-02T12:00:00.000Z",
        responseObservedAt: "2026-09-02T12:00:01.750Z",
        source: "request-to-observed-message",
      },
    });
  });

  it("leaves harness cleanup headroom while proving no reply", async () => {
    const implementation = {
      buildRun: () => ({
        kind: "channel-message" as const,
        expectReply: false,
        input: "ignore this",
        expectedTextIncludes: [],
        matchText: "must not appear",
      }),
    } satisfies DiscordQaScenarioImplementation;
    const environment = createScenarioEnvironment({
      configureScenario: vi.fn(async () => ({ cfg: {}, run: implementation.buildRun() })),
      scenario: { id: "discord-mention-gating", timeoutMs: 8_000, title: "Mention gating" },
    });
    vi.spyOn(testing, "sendChannelMessage").mockResolvedValue(
      sentMessage("523456789012345678", "2026-09-02T12:00:00.000Z"),
    );
    const poll = vi.spyOn(testing, "pollChannelMessages").mockImplementation(async (params) => {
      throw new Error(`timed out after ${params.timeoutMs}ms waiting for Discord message`);
    });

    await expect(runDiscordScenario(environment, implementation)).resolves.toEqual({
      details: "no reply",
    });
    expect(poll).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5_000 }));
  });
});
