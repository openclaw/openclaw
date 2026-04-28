Summary

Reviewed PR #15 and produced a bounded local repair. The PR’s goal is valid, but the original stub was too thin for the plugin loader contract once `index.ts` makes the manifest discoverable.

Vision

Ship the missing `extensions/bench-reflective-dreaming/index.ts` so the no-`package.json` scripts-runtime plugin can be discovered by the bundled plugin build, while keeping real behavior in `scripts/install.mjs` and `scripts/uninstall.mjs` and avoiding import-time side effects.

Acceptance Criteria

- `bench-reflective-dreaming` has a real `./index.ts` because bundled plugin build entries default manifest-only plugins to `./index.ts` in `scripts/lib/bundled-plugin-build-entries.mjs:47`.
- Build/pack metadata includes `dist/extensions/bench-reflective-dreaming/index.js` and `openclaw.plugin.json`.
- Importing or explicitly enabling the plugin does not register cron jobs, providers, channels, tools, or services.
- If the plugin is explicitly enabled, the loader must not fail the plugin module contract.
- No auth, billing, Firestore, checkout, or UI surface is changed.

Verdict

REPAIR

Findings

- Medium, repaired: The PR’s original `export const PLUGIN_RUNTIME = "scripts" as const` satisfied tsdown, but it was not a valid OpenClaw plugin module. Once `extensions/bench-reflective-dreaming/index.ts` exists, explicit enablement can import it; `src/plugins/loader.ts:2201` rejects modules without `register` or `activate`. Repaired by making `extensions/bench-reflective-dreaming/index.ts:6` a no-op `definePluginEntry`.
- No unrepaired security, auth, billing, Firestore, UI, or data-loss findings.

Repairs Attempted

Replaced the bare constant stub with a no-op plugin entry in `extensions/bench-reflective-dreaming/index.ts`. This preserves the scripts-runtime design while satisfying both tsdown and the loader contract.

Repair patch: /Users/coryshelton/clawd/openclaw/artifacts/anvil/pr-15-20260428T074754Z/anvil-repair.patch

Verification

- Harness deterministic checks: skipped by `--no-checks`; no failed logs to classify.
- Installed dependencies with `pnpm install`.
- Explicit enabled load check: `bench-reflective-dreaming` returned `status: "loaded"` with no diagnostics.
- `pnpm test test/scripts/bundled-plugin-build-entries.test.ts src/infra/tsdown-config.test.ts src/plugins/bundled-plugin-metadata.test.ts src/plugins/contracts/plugin-entry-guardrails.test.ts` passed.
- `pnpm check` passed.
- `pnpm build` passed and emitted `dist/extensions/bench-reflective-dreaming/index.js`.
- `git diff --check` passed.
- Worktree is dirty only in `extensions/bench-reflective-dreaming/index.ts`.

Remaining Risks

Full `pnpm test` was not run. The covered surface is narrow, and the direct plugin/build tests plus `pnpm check` and `pnpm build` passed.

Recommended Repair Pass

Apply the Anvil repair patch to the PR branch, then rerun:

`pnpm test test/scripts/bundled-plugin-build-entries.test.ts src/infra/tsdown-config.test.ts src/plugins/bundled-plugin-metadata.test.ts src/plugins/contracts/plugin-entry-guardrails.test.ts`

`pnpm check`

`pnpm build`

Handoff

Do not ship the PR as-is. Apply the one-file repair first. After that, the PR matches the reconstructed vision and has clean local evidence for the touched build/plugin-loader surface.
