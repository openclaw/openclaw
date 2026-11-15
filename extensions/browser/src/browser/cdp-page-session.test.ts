// Browser tests cover CDP committed page-session URL observation.
import { describe, expect, it } from "vitest";
import { prepareCdpTargetSession, readCdpDocumentIdentities } from "./cdp-page-session.js";
import type { CdpSendFn } from "./cdp.helpers.js";

describe("prepareCdpTargetSession", () => {
  it("keeps main identity while distinguishing same-URL child documents deterministically", async () => {
    const frame = { id: "main", loaderId: "main-loader", url: "https://example.test" };
    const children = [
      { frame: { id: "child-b", loaderId: "loader-b", url: "about:srcdoc" } },
      { frame: { id: "child-a", loaderId: "loader-a", url: "about:srcdoc" } },
    ];
    const send: CdpSendFn = async () => ({ frameTree: { frame, childFrames: children } });
    const first = await readCdpDocumentIdentities(send);
    expect(first.mainFrame).toBe("cdp:main-loader");
    expect(first.frameTree).toBeTypeOf("string");
    children.reverse();
    frame.url = "https://example.test#same-document";
    expect(await readCdpDocumentIdentities(send)).toEqual(first);
    children[0]!.frame.loaderId = "replacement-loader";
    const navigated = await readCdpDocumentIdentities(send);
    expect(navigated.mainFrame).toBe(first.mainFrame);
    expect(navigated.frameTree).not.toBe(first.frameTree);
  });

  it("omits the tree baseline when a child has no committed loader", async () => {
    const send: CdpSendFn = async () => ({
      frameTree: {
        frame: { id: "main", loaderId: "main-loader" },
        childFrames: [{ frame: { id: "initial-child" } }],
      },
    });
    expect(await readCdpDocumentIdentities(send)).toEqual({ mainFrame: "cdp:main-loader" });
  });

  it("ignores Chrome's transient colon URL while navigation is settling", async () => {
    let frameReadCount = 0;
    const send: CdpSendFn = async (method) => {
      if (method === "Target.attachToTarget") {
        return { sessionId: "SESSION" };
      }
      if (method === "Page.getFrameTree") {
        frameReadCount += 1;
        return {
          frameTree: {
            frame:
              frameReadCount <= 8
                ? { loaderId: "LOADER_TRANSIENT", url: ":" }
                : { loaderId: "LOADER_FINAL", url: "https://example.com/final" },
          },
        };
      }
      return {};
    };

    await expect(
      prepareCdpTargetSession(send, "TARGET", "https://example.com/start"),
    ).resolves.toBe("https://example.com/final");
    expect(frameReadCount).toBeGreaterThan(8);
  });
});
