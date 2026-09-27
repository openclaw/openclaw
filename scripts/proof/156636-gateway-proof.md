# #156636 patched-Gateway proof procedure

This procedure captures redacted `/status` and `session_status` output from a
**patched scratch Gateway** for the three cases ClawSweeper asked for:

1. fresh session
2. existing-session recovery (persisted 128k from the synthetic fallback)
3. account switch

The capture script is `scripts/proof/156636-gateway-proof.mjs`. It only talks to an
already-running Gateway through `openclaw gateway call`. It never starts or stops a
Gateway, never writes config, never reads credential files, and never sends a model
turn unless you pass `--run-turn`. **A human runs it.** Nothing in this PR ran it
against a real account.

## What the script records

For one session key it records:

- `sessions.describe`, reduced to `modelProvider`, `model`, `agentHarnessId`,
  `contextTokens`, `contextTokensSource`, `totalTokens` and `modelSelectionLocked`
- the `session_status` tool (`tools.invoke`), context/model lines only
- a `/status` command (`chat.send` with `deliver: false`) read back through
  `chat.history`, context/model lines only

All output passes through `redact()` before it is printed or written. That function
removes bearer/API/Copilot/GitHub tokens, JWTs, long hex strings, every non-public
URL host (it becomes `<private-endpoint>`), IPv4/IPv6 addresses, tailnet/LAN host
names, email addresses, phone numbers, home-directory paths, account/profile/session
IDs and UUIDs. Session keys are reduced to `agent:<id>:<redacted-peer>`. Run
`node scripts/proof/156636-gateway-proof.mjs --self-test` to see the rules applied to
a sample containing each kind of secret. **Read the output before posting it
anyway**: redaction is pattern-based and cannot promise to catch everything.

## Setup (scratch only)

1. Build this branch and use a scratch state directory and profile. Do not reuse the
   production state directory:
   ```sh
   pnpm install --frozen-lockfile && pnpm build
   export OPENCLAW_STATE_DIR="$(mktemp -d)"
   ```
2. Sign in to a GitHub Copilot account in that scratch profile yourself. Do this in
   the terminal or Control UI, never through the script.
3. Pick a Copilot model that is **not** in the curated static list, so the 128k
   synthetic fallback applies. Do **not** add a `models.providers.github-copilot`
   size pin for it.
4. Start the Gateway: `openclaw gateway run` (or your usual supervised start). Wait
   for it to report ready.
5. Note the Gateway URL from `openclaw status --json` (`gateway.url`) and pass it as
   `--expect-url`, so the calls cannot silently go to a different Gateway.

## 1. Fresh session

```sh
node scripts/proof/156636-gateway-proof.mjs --phase fresh \
  --session-key agent:main:proof-fresh \
  --model github-copilot/<uncurated-model> --expect-url <gateway-url>
```

Expected on the patched build once discovery has published: `/status` and
`session_status` show the account's prompt limit (for example `/872k`), not `/128k`.

## 2. Existing-session recovery

Prepare a session whose row was written against the synthetic fallback:

1. On an **unpatched** build (or before sign-in/discovery completes), run one ordinary
   turn in `agent:main:proof-existing` on the uncurated model. `sessions.describe`
   should then show `contextTokens: 128000`.
2. Switch to the patched build, then run one turn **before** discovery publishes (for
   example while signed out), so the row carries `contextTokensSource: "synthetic"`.
3. Sign in, let discovery publish, and **do not restart the Gateway**. Then capture:

```sh
node scripts/proof/156636-gateway-proof.mjs --phase existing \
  --session-key agent:main:proof-existing --expect-url <gateway-url>
# optional: also observe after one ordinary run
node scripts/proof/156636-gateway-proof.mjs --phase existing \
  --session-key agent:main:proof-existing --run-turn --expect-url <gateway-url>
```

Expected: the synthetic row reads the admitted owner's accepted limit (`/872k`)
without a restart. As a control, a row whose `contextTokensSource` is `runtime`
(genuine telemetry) stays at `/128k`. If the owner cannot answer (signed out, or
discovery failed), the card shows `?` for the window, not `128k` and not another
account's value.

Note: rows written by builds without this PR carry no `synthetic` marker. They are
indistinguishable from genuine telemetry and deliberately stay conservative until
the next run rewrites them. Step 2 exists for that reason.

## 3. Account switch

```sh
node scripts/proof/156636-gateway-proof.mjs --phase account --label before \
  --session-key agent:main:proof-fresh --expect-url <gateway-url>
# switch the scratch profile to a second Copilot account yourself, wait for publication
node scripts/proof/156636-gateway-proof.mjs --phase account --label after \
  --session-key agent:main:proof-fresh --expect-url <gateway-url>
```

Expected: `after` shows only the second account's accepted limit. While the switch
is pending, or if the second account's discovery fails, the limit must not be the
first account's value. It stays at the conservative fallback, or `?` for a synthetic
row.

## Posting

The script writes `156636-proof-<phase>[-label].md` in the current directory. Review
it, then paste the relevant blocks into the PR under "Real behavior proof". Say which
build/commit and which cases were run, and include negative results.
