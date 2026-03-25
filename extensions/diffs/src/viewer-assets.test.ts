import { describe, expect, it } from "vitest";
import { getServedViewerAsset, VIEWER_LOADER_PATH, VIEWER_RUNTIME_PATH } from "./viewer-assets.js";

describe("viewer assets", () => {
  it("serves a stable loader that points at the current runtime bundle", async () => {
    const loader = await getServedViewerAsset(VIEWER_LOADER_PATH);

    expect(loader?.contentType).toBe("text/javascript; charset=utf-8");
    expect(String(loader?.body)).toContain(`${VIEWER_RUNTIME_PATH}?v=`);
  });

  it("serves the runtime bundle body", async () => {
    const runtime = await getServedViewerAsset(VIEWER_RUNTIME_PATH);

    expect(runtime?.contentType).toBe("text/javascript; charset=utf-8");
    expect(String(runtime?.body)).toContain("openclawDiffsReady");
  });

  it("returns null for unknown asset paths", async () => {
    await expect(getServedViewerAsset("/plugins/diffs/assets/not-real.js")).resolves.toBeNull();
  });
});
