import { beforeEach, describe, expect, it, vi } from "vitest";

const readLatestNemoClawDigestCacheMock = vi.fn();

vi.mock("./latest-digest-cache.js", () => ({
  readLatestNemoClawDigestCache: readLatestNemoClawDigestCacheMock,
}));

describe("handleNemoClawCommand", () => {
  beforeEach(() => {
    readLatestNemoClawDigestCacheMock.mockReset();
  });

  it("returns formatted latest digest text", async () => {
    readLatestNemoClawDigestCacheMock.mockResolvedValue({
      notification_digest_summary: [
        {
          digest_title: "Auth failures (immediate)",
          digest_bucket_ui_layouts: {
            meta: {
              summary_parts: {
                display: {
                  badge: { short: "MAJ" },
                  leader: { compact: "Leader ★" },
                },
                percent: "50.0%",
                share: 0.5,
              },
            },
          },
        },
      ],
    });
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("digest")).resolves.toEqual({
      text: "Auth failures (immediate)\nMAJ | 50.0% | Leader ★ | share=0.5",
    });
  });

  it("returns no-data text when there is no digest", async () => {
    readLatestNemoClawDigestCacheMock.mockResolvedValue(null);
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("digest")).resolves.toEqual({
      text: "No notification_digest_summary available.",
    });
  });
});
