# Root Cause Analysis — issue-99901

## Symptom

`src/agents/sessions/model-resolver.ts:513` calls `process.exit(1)` inside `findInitialModel()`, a library function used by the agent session SDK.

## 5 Whys

1. **Why does the process exit?** — `findInitialModel()` calls `process.exit(1)` when `cliProvider && cliModel` are provided but `resolveCliModel()` returns an error.
2. **Why does it call process.exit instead of returning the error?** — The function returns `Promise<InitialModelResult>`, which includes a `model` field that is `undefined` when resolution fails. The author chose to crash rather than return `{ model: undefined }`.
3. **Why was crashing chosen?** — CLI arg misconfiguration was treated as a fatal user error ("you typed a wrong model name, fix it and retry"), without considering non-CLI consumers of the same function.
4. **Why is this a library function callable from non-CLI paths?** — `findInitialModel()` is exported from `model-resolver.ts` and imported by `sdk.ts` (agent session core). It's designed as the central model-resolution entry point, shared across CLI, Gateway, and test runners.
5. **Why hasn't this caused a production crash?** — Currently no caller passes `cliProvider`/`cliModel` to `findInitialModel()`, so the branch is dead code. It's a ticking bomb for any future caller that does.

## Code Location

| Item | Detail |
|------|--------|
| File | `src/agents/sessions/model-resolver.ts` |
| Line | 511–513 |
| Function | `findInitialModel()` |
| Symptom | `process.exit(1)` in a library function |

## Impact

- **Current**: Dead code — no caller passes CLI args.
- **Future bomb**: Any new caller that passes `cliProvider` + `cliModel` with an invalid combination crashes the entire process instead of propagating an error.
- **Scenarios**: Gateway agent session init, test fixtures, extension SDK usage, ACP server sessions.
