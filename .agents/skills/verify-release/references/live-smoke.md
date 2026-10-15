# Isolated release smoke

This is disposable verification, not an update of the operator's Gateway.
Human release validation still uses its existing OCM preparation and containment
checks; this recipe does not replace them.

## Select authentication before setup

| Path             | Credential owner                                                                 | Isolation                                                                                  |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| API key          | Inherited provider key, such as `OPENAI_API_KEY`                                 | Empty disposable OpenClaw auth store; use the provider's API-key model route.              |
| OpenClaw OAuth   | Dedicated smoke account/profile already authenticated in the disposable target   | Default per-agent harness scope; refresh writes stay in that target's store.               |
| Native CLI OAuth | Dedicated native CLI fixture, using that provider's supported directory selector | Preserve the real OS `HOME` and Keychain environment; select only the fixture's directory. |

An existing personal login is not automatically an isolated fixture. Do not
copy auth databases, `auth.json`, refresh tokens, or Keychain entries from the
main installation. Refresh tokens may rotate or invalidate the original login.
Do not create a second refresh owner for an account in active use. If no
independent OAuth fixture is available, record OAuth as **not run: dedicated
credential fixture required**; API-key success is not OAuth success. Use the
configured credential workflow for a missing API key, never print its value.

For Codex, the default OpenClaw per-agent home uses an ephemeral Codex auth
store and OpenClaw-owned authentication. Setting `CODEX_HOME` alone does not
make that mode consume a native login. Native account reuse requires the
documented `appServer.homeScope: "user"` opt-in and uses the selected
`CODEX_HOME`, or `~/.codex` if unset. Use only a dedicated native fixture for
that opt-in: native runs may refresh credentials and write threads/config.
Changing `CODEX_HOME` also changes Codex's Keychain account identity; it is
not a way to reuse the personal login read-only.

For another provider, inspect its existing auth/runner contract before choosing
its directory selector. Do not globally redirect XDG directories or invent a
universal CLI credential layout. A Keychain prompt is a prerequisite problem:
stop the owned smoke process, correct its credential environment, and report
the unexecuted path. Never recommend resetting or unlocking Keychain as a
smoke-test repair.

## Disposable OpenClaw target

Use a private directory created for this run. In a subshell, preserve `HOME`,
`USERPROFILE`, the native login session, and provider-required OS credential
environment. Explicitly replace inherited OpenClaw selectors:

```bash
smoke_root=$(mktemp -d "${TMPDIR:-/tmp}/openclaw-release-smoke.XXXXXX")
export OPENCLAW_HOME="$smoke_root/home"
export OPENCLAW_STATE_DIR="$smoke_root/state"
export OPENCLAW_CONFIG_PATH="$smoke_root/state/openclaw.json"
export OPENCLAW_WORKSPACE_DIR="$smoke_root/workspace"
export OPENCLAW_AGENT_DIR="$smoke_root/state/agents/dev/agent"
export CODEX_HOME="$smoke_root/codex"
unset PI_CODING_AGENT_DIR OPENCLAW_OAUTH_DIR
unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD
unset OPENCLAW_CONFIG_READONLY OPENCLAW_INCLUDE_ROOTS
export npm_config_cache="$smoke_root/npm-cache"
export npm_config_prefix="$smoke_root/install"
```

The empty `CODEX_HOME` prevents discovery/bootstrap from borrowing the personal
Codex login, including on the API-key path. For a native CLI OAuth check,
replace it with the independently owned fixture's directory, never the personal
CLI directory. Apply the selected provider's corresponding directory contract
before its discovery/setup commands too.

Use the same environment for every setup, auth, model, Gateway and client
command. Keep the candidate installation and execution cwd disposable too;
published-package checks use `npm exec --yes --package openclaw@<VERSION>`
there. For a source candidate, use a task-owned checkout with its existing
`pnpm openclaw` wrapper, not the active checkout's outputs. Do not change the
operator's global npm install or service configuration.

Choose and verify an unused loopback port, set `OPENCLAW_GATEWAY_PORT` to it,
and pass that same port explicitly to the foreground server:

```bash
pnpm openclaw --dev gateway run --bind loopback --port "$OPENCLAW_GATEWAY_PORT" --auth none --verbose
```

Do not use `--force`, `--reset`, service install/restart, or a default-port
fallback. If another process acquires the port, choose a different unused
port; never stop the other owner. Dev bootstrap may add a `-dev` workspace
suffix; verify the resolved workspace remains inside `smoke_root`.

Before inference, verify resolved config, state, agent directory, workspace,
installation, and native-provider fixture paths belong to this run. Do not
import the personal config or enable its channels, hooks, or automations.
Confirm the selected provider/model and authentication path without exposing
credential values. An API key inherited alongside OAuth must not silently
turn the OAuth check into an API-key check.

## Evidence and closeout

- Require `GET http://127.0.0.1:<PORT>/healthz` to return HTTP 200 and exactly
  `{"ok":true,"status":"live"}` for the auth-none target.
- Use the explicit target port for the client. Require a successful
  Gateway-backed agent turn, not local embedded fallback. Record the release
  version/source, provider/model, authentication kind (`api-key`,
  `openclaw-oauth`, or `native-cli-oauth`), result, and matching Gateway run id.
- Record prerequisites separately from test failures. Do not claim OAuth,
  refresh, absence of a native dialog, or an unchanged personal credential
  store from an API-key test, a mock, or source inspection.
- Stop only the process started for this run and verify its port is closed.
  Remove disposable installation/state/workspace/cache after owned processes
  settle. Preserve a reusable OAuth fixture and its credentials with its
  existing owner; never log out or delete the personal/native account during
  cleanup. Retain only sanitized outcome evidence, not raw credential stores.
