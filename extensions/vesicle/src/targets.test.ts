import { describe, expect, it } from "vitest";
import {
  inferVesicleTargetChatType,
  looksLikeVesicleExplicitTargetId,
  normalizeVesicleMessagingTarget,
  parseVesicleTarget,
  resolveVesicleOutboundSessionRoute,
} from "./targets.js";

describe("Vesicle targets", () => {
  it("parses prefixed and raw chat GUID targets", () => {
    expect(parseVesicleTarget("chat_guid:iMessage;-;+15551234567")).toEqual({
      kind: "chat_guid",
      chatGuid: "iMessage;-;+15551234567",
    });
    expect(parseVesicleTarget("vesicle:iMessage;+;chat123")).toEqual({
      kind: "chat_guid",
      chatGuid: "iMessage;+;chat123",
    });
  });

  it("keeps handles parseable but not explicit send targets", () => {
    expect(parseVesicleTarget("+15551234567")).toEqual({
      kind: "handle",
      to: "+15551234567",
    });
    expect(looksLikeVesicleExplicitTargetId("+15551234567")).toBe(false);
  });

  it("normalizes explicit chat GUID targets", () => {
    expect(normalizeVesicleMessagingTarget("vesicle:guid:iMessage;+;chat123")).toBe(
      "chat_guid:iMessage;+;chat123",
    );
    expect(looksLikeVesicleExplicitTargetId("iMessage;+;chat123")).toBe(true);
  });

  it("infers chat type from the Vesicle chat GUID separator", () => {
    expect(inferVesicleTargetChatType("chat_guid:iMessage;-;+15551234567")).toBe("direct");
    expect(inferVesicleTargetChatType("chat_guid:iMessage;+;chat123")).toBe("group");
    expect(inferVesicleTargetChatType("+15551234567")).toBeUndefined();
  });

  it("builds direct outbound session routes using the DM handle as peer id", () => {
    const route = resolveVesicleOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "chat_guid:iMessage;-;+15551234567",
    });
    expect(route?.chatType).toBe("direct");
    expect(route?.peer).toEqual({ kind: "direct", id: "+15551234567" });
    expect(route?.to).toBe("vesicle:chat_guid:iMessage;-;+15551234567");
  });
});
