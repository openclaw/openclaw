# Daily Baseline Failure Report — 2026-03-04

## Environment

- Repo: `openclaw/openclaw`
- Branch at baseline: `main`
- Install command: `timeout 900 pnpm install --frozen-lockfile --reporter=append-only`

## Gate Results (Baseline)

- `test`: **FAIL** (`timeout 1200 pnpm -r test`)
- `lint`: PASS (`timeout 1200 pnpm -r lint`) — no lint script in selected packages
- `build`: PASS (`timeout 1200 pnpm -r build`)
- `coverage`: N/A/PASS (`timeout 1200 pnpm -r coverage`) — no coverage script in selected packages

## Baseline Test Failures Observed

- `src/ui/config-form.browser.test.ts` (1)
- `src/ui/focus-mode.browser.test.ts` (1)
- `src/ui/navigation.test.ts` (1)
- `src/ui/open-external-url.test.ts` (1)
- `src/i18n/test/translate.test.ts` (1)
- `src/ui/storage.node.test.ts` (2)
- `src/ui/views/cron.test.ts` (2)

> Note: test count exhibited non-determinism across reruns; post-change rerun still failed but did not introduce additional gate failures/warnings.
