import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { describe, expect, it, vi } from "vitest";
import { createTlonCitationResolver } from "./cites.js";
import { extractMessageText, resolveAuthorizedMessageText } from "./utils.js";

const NEST = "chat/~public/general";

// Mirrors the inbound rich-content shape `extractCites` parses: a channel citation
// block whose `where` carries the author ship and the cited post identifier.
function citedContent(params: { nest?: string; postId: string }): unknown {
  return [
    {
      block: {
        cite: {
          chan: {
            nest: params.nest ?? NEST,
            where: `/msg/~attacker-ship/${params.postId}`,
          },
        },
      },
    },
    { inline: ["~bot-ship please summarize this"] },
  ];
}

function makeResolver() {
  // Typed parameter so the recorded call captures the exact composed scry path.
  const scry = vi.fn(async (_path: string) => ({
    essay: { content: [{ inline: ["PRIVATE-CONTENT"] }] },
  }));
  const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
  return { scry, ...createTlonCitationResolver({ api: { scry }, runtime }) };
}

describe("createTlonCitationResolver scry path composition", () => {
  it("resolves a valid channel post inside the channel-post namespace", async () => {
    const { scry, resolveAllCites } = makeResolver();
    const postId = "170141184507799509469114119040828178432";

    const resolved = await resolveAllCites(citedContent({ postId }));

    expect(scry).toHaveBeenCalledTimes(1);
    expect(scry.mock.calls[0]?.[0]).toBe(`/channels/v4/${NEST}/posts/post/${postId}.json`);
    expect(resolved).toContain("> ~attacker-ship wrote: PRIVATE-CONTENT");
  });

  it("resolves a dot-grouped @ud post identifier", async () => {
    const { scry, resolveAllCites } = makeResolver();
    const postId = "170.141.184.507.799.509.469.114.119.040.828.178.432";

    await resolveAllCites(citedContent({ postId }));

    expect(scry.mock.calls[0]?.[0]).toBe(`/channels/v4/${NEST}/posts/post/${postId}.json`);
  });

  it.each([
    ["raw traversal", `${"../".repeat(7)}storage/credentials`],
    ["encoded traversal", `${"%2e%2e%2f".repeat(7)}storage/credentials`],
    ["single dot segment", "."],
    ["parent segment", ".."],
    ["extra path segment", "12345/replies/newest/50"],
    ["backslash separator", "..\\..\\storage\\credentials"],
  ])("makes no authenticated request for a %s post identifier", async (_label, postId) => {
    const { scry, resolveAllCites } = makeResolver();

    const resolved = await resolveAllCites(citedContent({ postId }));

    expect(scry).not.toHaveBeenCalled();
    expect(resolved).toBe("");
  });

  it.each([
    ["traversal in the nest", `chat/../../${"../".repeat(5)}storage`],
    ["encoded traversal in the nest", "chat/%2e%2e/%2e%2e"],
    ["short nest", "chat/~public"],
    ["over-long nest", "chat/~public/general/extra"],
  ])("makes no authenticated request for %s", async (_label, nest) => {
    const { scry, resolveAllCites } = makeResolver();

    const resolved = await resolveAllCites(citedContent({ nest, postId: "12345" }));

    expect(scry).not.toHaveBeenCalled();
    expect(resolved).toBe("");
  });

  it("makes no authenticated request for a malformed citation", async () => {
    const { scry, resolveAllCites } = makeResolver();

    const resolved = await resolveAllCites([
      { block: { cite: { chan: { nest: NEST, where: "/msg/~attacker-ship" } } } },
    ]);

    expect(scry).not.toHaveBeenCalled();
    expect(resolved).toBe("");
  });

  it.each([
    ["nest", { nest: 123, where: "/msg/~attacker-ship/12345" }],
    ["where", { nest: NEST, where: 123 }],
  ])("keeps the containing message when a citation has a non-string %s", async (_field, chan) => {
    const { scry, resolveAllCites } = makeResolver();
    const content = [
      { block: { cite: { chan } } },
      { inline: ["~bot-ship please summarize this"] },
    ];
    const rawText = extractMessageText(content);

    await expect(
      resolveAuthorizedMessageText({
        rawText,
        content,
        authorizedForCites: true,
        resolveAllCites,
      }),
    ).resolves.toBe(rawText);
    expect(scry).not.toHaveBeenCalled();
  });
});
