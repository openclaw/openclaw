---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: Node + tsx "__name is not a function" crash notes and workarounds（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging Node-only dev scripts or watch mode failures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Investigating tsx/esbuild loader crashes in OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Node + tsx Crash"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Node + tsx "\_\_name is not a function" crash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Running OpenClaw via Node with `tsx` fails at startup with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[openclaw] Failed to start CLI: TypeError: __name is not a function（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    at .../src/agents/auth-profiles/constants.ts:25:20（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This began after switching dev scripts from Bun to `tsx` (commit `2871657e`, 2026-01-06). The same runtime path worked with Bun.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Environment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node: v25.x (observed on v25.3.0)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- tsx: 4.21.0（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OS: macOS (repro also likely on other platforms that run Node 25)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Repro (Node-only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# in repo root（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
node --version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
node --import tsx src/entry.ts status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Minimal repro in repo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
node --import tsx scripts/repro/tsx-name-repro.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Node version check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node 25.3.0: fails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node 22.22.0 (Homebrew `node@22`): fails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node 24: not installed here yet; needs verification（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes / hypothesis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tsx` uses esbuild to transform TS/ESM. esbuild’s `keepNames` emits a `__name` helper and wraps function definitions with `__name(...)`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The crash indicates `__name` exists but is not a function at runtime, which implies the helper is missing or overwritten for this module in the Node 25 loader path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Similar `__name` helper issues have been reported in other esbuild consumers when the helper is missing or rewritten.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Regression history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `2871657e` (2026-01-06): scripts changed from Bun to tsx to make Bun optional.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Before that (Bun path), `openclaw status` and `gateway:watch` worked.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Workarounds（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use Bun for dev scripts (current temporary revert).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use Node + tsc watch, then run compiled output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  pnpm exec tsc --watch --preserveWatchOutput（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  node --watch openclaw.mjs status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirmed locally: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` works on Node 25.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Disable esbuild keepNames in the TS loader if possible (prevents `__name` helper insertion); tsx does not currently expose this.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Test Node LTS (22/24) with `tsx` to see if the issue is Node 25–specific.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## References（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Next steps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Repro on Node 22/24 to confirm Node 25 regression.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Test `tsx` nightly or pin to earlier version if a known regression exists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If reproduces on Node LTS, file a minimal repro upstream with the `__name` stack trace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
