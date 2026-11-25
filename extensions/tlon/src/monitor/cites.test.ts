import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveTlonCitations } from "./cites.js";

const NEST = "chat/~public/general";

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
  return {
    scry,
    resolve: (content: unknown) => resolveTlonCitations(content, () => true, { scry }, runtime),
  };
}
describe("Tlon citation scry path composition", () => {
  it("resolves a valid channel post inside the channel-post namespace", async () => {
    const { scry, resolve } = makeResolver(),
      postId = "170141184507799509469114119040828178432";
    const resolved = await resolve(citedContent({ postId }));
    expect(scry).toHaveBeenCalledTimes(1);
    expect(scry.mock.calls[0]?.[0]).toBe(`/channels/v4/${NEST}/posts/post/${postId}.json`);
    expect(resolved).toContain("> ~attacker-ship wrote: PRIVATE-CONTENT");
  });
  it("rechecks citation scope at the authenticated request boundary", async () => {
    let allowed = true;
    let requests = 0;
    let revokeBeforeRequest = true;
    const scry = vi.fn(async (_path: string, beforeRequest?: () => void) => {
      if (revokeBeforeRequest) {
        allowed = false;
      }
      beforeRequest?.();
      requests += 1;
      allowed = false;
      return { essay: { content: [{ inline: ["PRIVATE-CONTENT"] }] } };
    });
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
    const resolved = await resolveTlonCitations(
      citedContent({ postId: "12345" }),
      () => allowed,
      { scry },
      runtime,
    );
    expect(requests).toBe(0);
    expect(resolved).toBe("");
    allowed = true;
    revokeBeforeRequest = false;
    await expect(
      resolveTlonCitations(citedContent({ postId: "12345" }), () => allowed, { scry }, runtime),
    ).resolves.toBe("");
    expect(requests).toBe(1);
  });
  it.each([
    ["raw traversal", `${"../".repeat(7)}storage/credentials`],
    ["single dot segment", "."],
  ])("makes no authenticated request for a %s post identifier", async (_label, postId) => {
    const { scry, resolve } = makeResolver();
    const resolved = await resolve(citedContent({ postId }));
    expect(scry).not.toHaveBeenCalled();
    expect(resolved).toBe("");
  });
  it.each([
    ["encoded traversal in the nest", "chat/%2e%2e/%2e%2e"],
    ["short nest", "chat/~public"],
  ])("makes no authenticated request for %s", async (_label, nest) => {
    const { scry, resolve } = makeResolver();
    const resolved = await resolve(citedContent({ nest, postId: "12345" }));
    expect(scry).not.toHaveBeenCalled();
    expect(resolved).toBe("");
  });
  it("makes no authenticated request for a malformed citation", async () => {
    const { scry, resolve } = makeResolver();
    const resolved = await resolve([
      { block: { cite: { chan: { nest: NEST, where: "/msg/~attacker-ship" } } } },
    ]);
    expect(scry).not.toHaveBeenCalled();
    expect(resolved).toBe("");
  });
});
