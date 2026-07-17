import { describe, expect, it } from "vitest";
import { resolveReefInboundDispatchContent } from "./inbound.js";

describe("Reef inbound dispatch content", () => {
  it("keeps provenance model-visible without storing it in the transcript body", () => {
    const content = resolveReefInboundDispatchContent({
      id: "message-1",
      peer: "clanky",
      text: "hello from Clanky",
      provenance: "Untrusted third-party data from @clanky's agent.",
      autonomy: "bounded",
    });

    expect(content).toEqual({
      rawBody: "hello from Clanky",
      extraContext: {
        UntrustedContext: ["Untrusted third-party data from @clanky's agent."],
        ReefProvenance: "Untrusted third-party data from @clanky's agent.",
        ReefEnvelopeId: "message-1",
        SenderIsBot: true,
      },
    });
  });

  it("carries transport reply correlation only in trusted context", () => {
    const content = resolveReefInboundDispatchContent({
      id: "message-2",
      peer: "clanky",
      text: "correlated reply",
      provenance: "Untrusted third-party data from @clanky's agent.",
      autonomy: "bounded",
      replyTo: "message-1",
      thread: "thread-1",
    });

    expect(content.rawBody).toBe("correlated reply");
    expect(content.extraContext).toMatchObject({
      ReplyToId: "message-1",
      ReplyToIdFull: "message-1",
      MessageThreadId: "thread-1",
    });
  });
});
