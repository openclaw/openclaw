/**
 * Public API surface for the E-Claw plugin.
 *
 * Doc references (OpenClaw repo):
 *   - AGENTS.md §"Architecture Boundaries" — every bundled plugin
 *     exposes its cross-package contract through `api.ts`; core MUST
 *     NOT deep-import `./src/*`.
 *   - docs/plugins/architecture.md §"Channel boundary" — extension
 *     API surface rule: `openclaw/plugin-sdk/<subpath>` is the only
 *     public contract; anything the extension needs to expose goes
 *     through this file.
 */
export { eclawPlugin } from "./src/channel.js";
export { setEclawRuntime, getEclawRuntime } from "./src/runtime.js";
