/**
 * Image Strip Plugin
 *
 * Automatic image block stripping for the embedded agent runner.
 *
 * When the model returns an empty response and the context contains image
 * blocks (e.g. vision-claimed provider actually can't handle images),
 * strips all image blocks and retries. Also persists the strip to the
 * session file to prevent reload of problematic images.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { stripImageBlocksFromSessionFile } from "./src/image-strip.js";

export {
  stripImageBlocksFromMessages,
  stripImageBlocksFromSessionFile,
  isEmptyAssistantContent,
  isVisionRelatedError,
  type ImageStripResult,
} from "./src/image-strip.js";

const plugin = {
  id: "image-strip",
  name: "Image Strip",
  description:
    "Automatic image block stripping when model returns empty response",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.on("health", () => {
      return {
        imageStrip: {
          available: true,
          imageStripEnabled: true,
        },
      };
    });

    api.on("on_empty_response", (event) => {
      if (!event.sessionFile) {
        return; // no session file to strip
      }
      const strippedCount = stripImageBlocksFromSessionFile(event.sessionFile);
      if (strippedCount > 0) {
        return { retry: true };
      }
      // No images found — nothing to do, don't retry
    });
  },
};

export default plugin;
