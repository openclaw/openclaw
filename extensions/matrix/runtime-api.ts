// Keep the external runtime API light so Jiti callers can resolve Matrix config
// helpers without traversing the full plugin-sdk/runtime graph.
export * from "./src/auth-precedence.js";
export * from "./helper-api.js";
