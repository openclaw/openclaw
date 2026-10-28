import { afterEach, describe, expect, it, vi } from "vitest";
import { createInboundDiscussionBinding } from "../inbound.test-support.js";
import { captureDiscussionRegistration } from "./register.test-support.js";
import { createHarness } from "./service-test-support.js";
import { ClickClackDiscussionService } from "./service.js";

afterEach(() => vi.restoreAllMocks());

describe("ClickClack discussion tool", () => {
  it("returns a short unbound result without making a request", async () => {
    const readLatestMessages = vi.spyOn(
      ClickClackDiscussionService.prototype,
      "readLatestMessages",
    );
    const tool = captureDiscussionRegistration(createHarness(undefined).runtime).tool();

    const result = await tool.execute("call-1", {});

    expect(result.content).toEqual([
      { type: "text", text: "No discussion is bound to this session." },
    ]);
    expect(readLatestMessages).not.toHaveBeenCalled();
  });

  it("uses the default limit and returns formatted service output", async () => {
    const readLatestMessages = vi
      .spyOn(ClickClackDiscussionService.prototype, "readLatestMessages")
      .mockResolvedValue({
        binding: createInboundDiscussionBinding({ channelId: "chn_1" }),
        text: "2026-07-19T12:30:00.000Z [Alice] Status?",
      });
    const tool = captureDiscussionRegistration(createHarness(undefined).runtime).tool(
      "agent:main:main",
    );

    const result = await tool.execute("call-1", {});

    expect(readLatestMessages).toHaveBeenCalledWith("agent:main:main", 30);
    expect(result.content).toEqual([
      { type: "text", text: "2026-07-19T12:30:00.000Z [Alice] Status?" },
    ]);
    expect(result.details).toEqual({ bound: true, limit: 30, channelId: "chn_1" });
  });
});
