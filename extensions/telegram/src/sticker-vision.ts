import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadStickerVisionRuntime = createLazyRuntimeModule(
  () => import("./sticker-vision.runtime.js"),
);

export async function resolveStickerVisionSupport(
  params: Parameters<
    typeof import("./sticker-vision.runtime.js").resolveStickerVisionSupportRuntime
  >[0],
): Promise<boolean> {
  try {
    return await (await loadStickerVisionRuntime()).resolveStickerVisionSupportRuntime(params);
  } catch {
    return false;
  }
}
