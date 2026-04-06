// Private runtime barrel for the bundled Zalo extension.
// Keep this barrel thin and free of broad runtime re-exports so the bundled
// entry loader can resolve the channel plugin without dragging in setup or
// monitor surfaces just to read `zaloPlugin` / `setZaloRuntime`.
export { zaloPlugin } from "./src/channel.js";
export { setZaloRuntime } from "./src/runtime.js";
export { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
export { sendPayloadWithChunkedTextAndMedia } from "openclaw/plugin-sdk/reply-payload";
export type * from "./src/runtime-support.js";
