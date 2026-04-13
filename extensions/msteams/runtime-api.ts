// Private runtime barrel for the bundled Microsoft Teams extension.
// Keep this barrel thin and aligned with the local extension surface.

export * from "openclaw/plugin-sdk/msteams";
export { registerMSTeamsFullPlugin } from "./src/plugin-full.js";
export { setMSTeamsRuntime } from "./src/runtime.js";
