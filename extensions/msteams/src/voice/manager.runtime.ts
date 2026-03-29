// Lazy-load boundary for the voice manager.
// Dynamic import keeps the gRPC and voice dependencies out of the
// default load path when voice is disabled.

export { TeamsVoiceManager } from "./manager.js";
