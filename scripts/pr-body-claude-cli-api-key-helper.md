## What Problem This Solves

When Claude CLI is authenticated via `apiKeyHelper` in `~/.claude/settings.json` (the documented mechanism for corporate gateways and dynamic/proxy auth), OpenClaw's pre-spawn auth-gate returns `missing-provider-auth` (`No API key found for provider "anthropic"`), even though the Claude CLI itself authenticates and runs correctly.

The root cause: `readClaudeCliCredentials` / `readClaudeCliCredentialsCached` only reads macOS keychain or `~/.claude/.credentials.json`. There is no path for `apiKeyHelper`. When neither source has credentials, `resolveClaudeCliSyntheticAuth()` returns `undefined` — and both the provider-discovery descriptor and the runtime registration short-circuit before Claude is ever spawned.

This patch adds `hasClaudeCliApiKeyHelper()` to `cli-auth-seam.ts` (same owner boundary, same file-FS injection pattern as `extensions/google/oauth.settings.ts`). Both `resolveClaudeCliSyntheticAuth` functions now fall through to check `apiKeyHelper` when no stored credential exists. If present, they return a sentinel auth result (`CLAUDE_CLI_API_KEY_HELPER_MARKER`) that passes the gate — the actual key is still fetched by the Claude CLI helper script at spawn time, so no real secret ever touches OpenClaw.

Fixes #97489.

## Evidence

**Behavior addressed:** Linux users (or any host without `~/.claude/.credentials.json`) who use `apiKeyHelper` for proxy auth get `missing-provider-auth` before Claude CLI is spawned, blocking all claude-cli model routes.

**Real environment tested:** macOS local source checkout, Node v22.22.0, git `0f5aee0d16`, after `pnpm build` (runtime plugin loader reads built dist).

**Repro HOME shape (matches issue):**

```bash
# isolated HOME, deliberately NO ~/.claude/.credentials.json
mkdir -p "$HOME/.claude" "$HOME/bin"
cat > "$HOME/bin/get-anthropic-key.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s' "sk-ant-api03-proof-key-from-apiKeyHelper"
EOF
chmod +x "$HOME/bin/get-anthropic-key.sh"
cat > "$HOME/.claude/settings.json" <<EOF
{"apiKeyHelper":"$HOME/bin/get-anthropic-key.sh"}
EOF
unset ANTHROPIC_API_KEY ANTHROPIC_API_KEY_OLD CLAUDE_CODE_OAUTH_TOKEN
```

**Exact commands run after this patch:**

```bash
pnpm build
pnpm exec tsx scripts/proof-claude-cli-api-key-helper-auth.mjs

REPRO_HOME=$(mktemp -d /tmp/openclaw-gateway-proof-XXXXXX)
# ... same HOME setup as above ...
export HOME="$REPRO_HOME"
OPENCLAW_LIVE_CLI_BACKEND=1 \
OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=0 \
OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE=0 \
OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE=0 \
OPENCLAW_LIVE_TEST=1 \
pnpm test:live src/gateway/gateway-cli-backend.live.test.ts -- --reporter=verbose
```

**Evidence after fix — auth-gate proof script (`scripts/proof-claude-cli-api-key-helper-auth.mjs`):**

```
[step-1] hasClaudeCliApiKeyHelper()
  ok: settings.json apiKeyHelper detected
[step-2] provider-discovery resolveSyntheticAuth({ provider: claude-cli })
  result: {"apiKey":"claude-cli-api-key-helper","source":"Claude CLI apiKeyHelper","mode":"api-key"}
[step-3] resolveApiKeyForProvider({ provider: claude-cli }) — full auth-gate path
  result: {"apiKey":"claude-cli-api-key-helper","source":"Claude CLI apiKeyHelper","mode":"api-key"}

PASS: apiKeyHelper-only Claude CLI auth passes OpenClaw synthetic auth gate
```

**Evidence after fix — Claude CLI honors apiKeyHelper (direct CLI, same repro HOME):**

```
Failed to authenticate. API Error: 403 {"error":{"type":"forbidden","message":"Request not allowed"}}
```

This is expected with a fake helper key. It proves Claude CLI executed `apiKeyHelper` and reached the upstream API; it did **not** fail with missing local credentials.

**Evidence after fix — Gateway + agent pipeline live smoke (44s runtime, apiKeyHelper-only HOME):**

```
× gateway live (cli backend) > runs the agent pipeline against the local CLI backend 44328ms
  → FailoverError: Request not allowed
```

Log grep for the old failure mode returned **no matches** for `missing-provider-auth`, `No API key`, or `missing.api.key`.

Interpretation: OpenClaw passed the auth gate, spawned Claude CLI via the gateway agent pipeline, and the turn failed only at upstream API auth (403) because the proof helper emits a fake key. That is the correct post-fix failure mode for this repro setup.

**Observed result after fix:** `resolveApiKeyForProvider({ provider: "claude-cli" })` and the gateway CLI-backend live path no longer stop at `missing-provider-auth` when only `apiKeyHelper` is configured.

**What was not tested:** Live success against a real corporate proxy + real helper key (requires operator credentials). The proof intentionally uses a fake helper key to isolate the auth-gate regression without printing secrets.
