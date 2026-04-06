// Private runtime barrel for the bundled Zalo extension.
// Keep this barrel thin and free of local plugin self-imports so the bundled
// entry loader can resolve the channel plugin without re-entering this module.
export { zaloPlugin } from "./src/channel.js";
export * from "./src/runtime-api.js";
