import { definePluginEntry } from "./api.js";
import { createScreenshotTool, isScreenshotPlatformSupported } from "./screenshot-tool.js";

export default definePluginEntry({
  id: "screenshot",
  name: "Screenshot",
  description: "Owner-only screen capture tool for the Gateway host.",
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create(context) {
          // The screen belongs to the operator: expose the tool only to the
          // verified owner of the current turn, never to other allowed senders,
          // and never from sandboxed sessions that must not see the host.
          if (
            context.senderIsOwner !== true ||
            context.sandboxed === true ||
            !isScreenshotPlatformSupported()
          ) {
            return null;
          }
          return createScreenshotTool(context);
        },
      },
      { name: "screenshot", optional: true },
    );
  },
});
