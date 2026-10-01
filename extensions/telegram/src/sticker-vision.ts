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
    const { resolveStickerVisionSupportRuntime } = await loadStickerVisionRuntime();
    return await resolveStickerVisionSupportRuntime(params);
  } catch {
    return false;
  }
}
