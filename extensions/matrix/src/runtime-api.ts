export * from "openclaw/plugin-sdk/matrix";
// Keep auth-precedence available internally without re-exporting helper-api
// twice through both plugin-sdk/matrix and ../runtime-api.js.
export * from "./auth-precedence.js";
