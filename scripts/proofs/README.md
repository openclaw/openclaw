Real-behavior-proof reproducers for five external openclaw PRs.

Each `*.mts` imports the **patched modules from the corresponding PR branch** (paths are relative — `../../src/...` — so each script is meant to be run from a worktree on that PR's branch). The matching `*.captured.txt` is the live console output that was attached to the PR description as evidence.

## Reproducers

| Script                  | PR                                                        | Branch to check out                           |
| ----------------------- | --------------------------------------------------------- | --------------------------------------------- |
| `bootstrap-dos.mts`     | [#76322](https://github.com/openclaw/openclaw/pull/76322) | `security/bootstrap-dos-poc`                  |
| `preauth-bootstrap.mts` | [#77527](https://github.com/openclaw/openclaw/pull/77527) | `security/preauth-bootstrap-token-rate-limit` |
| `connect-schema.mts`    | [#77538](https://github.com/openclaw/openclaw/pull/77538) | `security/connect-schema-auth-bounds`         |
| `preauth-signature.mts` | [#77492](https://github.com/openclaw/openclaw/pull/77492) | `security/preauth-signature-rate-limit`       |

For [#75165](https://github.com/openclaw/openclaw/pull/75165) (`feat/gsar-termination-algebra`) the reproducer ships in that branch as `scripts/demo-gsar-algebra.ts` — no separate file here. Run it as `node --import tsx/esm scripts/demo-gsar-algebra.ts`.

## How to run one

```
git worktree add ../openclaw-<topic> <branch>
cd ../openclaw-<topic>
pnpm install --prefer-offline
node --import tsx/esm <path-to-reproducer>.mts
```

The reproducer path stays the same as in this branch; relative imports resolve against `../../src` from `scripts/proofs/`.

## Why these scripts exist

These were built to satisfy the `triage: needs-real-behavior-proof` gate enforced by `scripts/github/real-behavior-proof-policy.mjs`. Each one drives the changed contract end-to-end against the real patched module — no mocks of the patched code, no vitest harness — and prints a deterministic trace that gets pasted under the `## Real behavior proof` heading in the PR body.

The captured `*.captured.txt` files are the exact stdout bytes that were posted to the PRs; they are checked in alongside so anyone reading this branch can verify the reproducer output without re-running.
