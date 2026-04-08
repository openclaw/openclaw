/**
 * Public contract surface for the E-Claw channel plugin.
 *
 * Keep this intentionally small — it is what core facades and shared
 * plugin SDK subpaths may import. Everything else stays behind
 * `./src/*` and is invisible to the rest of the repo.
 *
 * Doc references (OpenClaw repo):
 *   - AGENTS.md §"Architecture Boundaries" → "Extension API surface
 *     rule" — `openclaw/plugin-sdk/<subpath>` is the only public
 *     cross-package contract; contract-api.ts is the companion
 *     per-plugin file that backs plugin-sdk subpaths when core needs
 *     plugin-owned types.
 *   - docs/plugins/architecture.md §"Plugin SDK import paths"
 */
export type { ResolvedEclawAccount } from "./src/types.js";
