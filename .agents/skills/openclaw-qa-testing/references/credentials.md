## QA credentials and 1Password

- Use `op` only inside `tmux` for QA secret lookup in this repo.
- Quick auth check inside tmux:

```bash
op account list
```

- Resolve approved 1Password item and field references for:
  - `OPENCLAW_QA_CONVEX_SITE_URL`
  - `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER` for the maintainer role
  - `OPENCLAW_QA_CONVEX_SECRET_CI` for the CI role
- If a required reference is missing or stale, ask the maintainer/operator for its current item and field reference.
  Do not ask for secret values in chat or copy them into logs or proof artifacts.
- The npm Telegram Docker lane requires Convex credential leasing.
  The lease supplies the Test Server SUT bot, QA-user authorization, and test-group metadata
  defined by [Telegram E2E userbot](../../telegram-e2e-userbot/SKILL.md).
  Direct Telegram token variables do not replace the required Convex configuration.
- Load the approved site URL and role-specific secret into the command's environment through the approved secret source.
  The preflight requires the site URL and matching role secret before the Docker run.
- With the maintainer configuration loaded, run:

```bash
OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE=convex \
OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE=maintainer \
OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE=mock-openai \
OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC="openclaw@beta" \
pnpm test:docker:npm-telegram-live
```

- `scripts/e2e/npm-telegram-live-runner.ts` reads `OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE`, not `OPENCLAW_QA_PROVIDER_MODE`.
- For authorized hosted proof, use the existing manual lane when its `qa-live-shared` environment has valid Convex CI configuration.
  A dispatch does not provision credentials or bypass a credential refusal.

```bash
ghx workflow run "NPM Telegram Beta E2E" --repo openclaw/openclaw --ref main \
  -f package_spec=openclaw@YYYY.M.D-beta.N \
  -f package_label=openclaw@YYYY.M.D-beta.N \
  -f provider_mode=mock-openai
```

- Poll the exact run id from the dispatch URL. `gh run view --json artifacts` is not supported; list artifacts with:

```bash
gh api repos/openclaw/openclaw/actions/runs/<run-id>/artifacts
```
