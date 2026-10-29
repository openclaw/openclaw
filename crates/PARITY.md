# Rust parity work ledger

## Target and completion rule

Native Rust feature parity remains the goal. This workspace is a partial prototype,
not a feature-complete OpenClaw distribution. Method names, discovered skill files,
provider URLs, successful compilation, and binary metadata do not prove parity.

Reference source: `fd0403b40c980de2ab8fe8d20b3d49f06a488596` (2026-10-28).
Reference release: GitHub `v2026.10.8`, published 2026-10-27; npm `openclaw@2026.10.8`.
These are distinct references; do not assume main equals the release.

Release package: `https://registry.npmjs.org/openclaw/-/openclaw-2026.10.8.tgz`.
Verified package integrity:
`sha512-fWOIOOyddIBqeuPz82DBCdY5kNl1yD51qebAHnxlTN7SmVoH5/WSIudR/N1zDhcIIksgJXe6ZgGy5ngSRxZOrQ==`.

REA static package analysis parent Evidence:
`ev_c5a47157443dccbd27d5cdcae40d4f46f3d3ec5ee602726e34e335bff57720e6`.
Selected files: `package.json`, `openclaw.mjs`, `dist/gateway-rpc.runtime.js`,
`dist/gateway-rpc.runtime-DBZBB6E9.mjs`.
Coverage is partial: 10,953 relevant files unselected; semantic unknown retention
reached its ceiling. No official runtime was executed. This is artifact identity
and bounded static evidence, not behavioral equivalence.

## Execution order

1. Inventory every reference surface and retain an explicit unknown/missing status.
2. Repair authentication, request framing, false success, and unsafe deployment defaults.
3. Match upstream handshake, wire schemas, method policies, events, and Control UI transport.
4. Implement one shared agent runtime: provider tool calls, cancellation, streaming,
   per-agent/account/session authority, durable history, routing, approvals, sandboxing.
5. Port tools, provider-specific authentication/APIs, complete channel lifecycles,
   plugin/skill runtimes, cron scheduling, hooks, memory, MCP, ACP, workers, and media.
6. Port CLI/config/doctor/migrations/lifecycle plus companion apps and packaging.
7. Prove each flow against both pinned source contracts and the released product;
   build and execute on Linux ARM64 before claiming ARM64 support.

No item is excluded by this ordering. Later items remain open, not silently waived.
Do not add unsafe execution tools before their authorization and approval owners exist.

## This continuation

- [x] Preserve existing uncommitted work; inspect Git state.
- [x] Pin local source and identify official release/package.
- [x] Verify npm package integrity and acquire bounded MCP REA evidence.
- [x] Capture an unfiltered baseline test log with native exit code: `0`.
  Log: `target/parity-baseline-tests.log` (generated, not committed).
- [ ] Add repeatable inventory with source locations and explicit extraction limits.
- [x] Reproduce Gateway auth bypass, then enforce configured authentication.
- [x] Reproduce dashboard auth/framing failures, then repair HTTP boundary and UI consumers.
- [x] Remove delivery success responses that perform no delivery.
- [x] Re-run affected tests and workspace build/test with native exit codes.
- [x] Align install paths/credentials with the documented contract and stop faking
      `gateway install` success. Install parity itself remains open (see below).

### Repairs landed (behavioral evidence, not parity)

Gateway (`openclaw-gateway`):
- `handle_connection` now requires a successful authenticated `connect` before any
  other method; pre-connect and post-connect `connect` are rejected, and auth failure
  never grants dispatch. Credential comparison is constant-time (`subtle`).
- `Gateway::run` resolves authentication before binding and refuses to start when
  auth is required without a usable secret.
- WebSocket frames are bounded by `gateway.maxFrameBytes`, and the upgrade has a
  30 s timeout.
- `message.send` returns `UNAVAILABLE` instead of `accepted: true`; no channel
  transport is wired to Gateway delivery yet.

Config (`openclaw-config`):
- `GatewayConfig` gained `authMode`/`authPassword`; `resolved_auth` and
  `resolved_auth_mode` implement upstream `token`/`password`/`none` selection and
  fail closed for `trusted-proxy`, which has no owner in this workspace.
- `load_json` no longer lets the permissive schema swallow upstream `gateway.auth`,
  `agents.defaults`, or `channels.*.accounts`; normalization now starts from a full
  parse so sibling sections survive.
- Default listener is `127.0.0.1:18789`; validation rejects a non-loopback listener
  with `auth.mode: "none"`, missing mode secrets, and token/password conflicts.

Dashboard (`openclaw-dashboard`):
- Requests are parsed incrementally by `Content-Length` (`HttpRequest`), replacing a
  single 64 KiB read; bodies over 25 MiB return `413`.
- All API endpoints require the shared Gateway credential (`401` otherwise), and the
  UI sends `Authorization: Bearer` on every call. Only `/healthz`, `/readyz`, and the
  static UI shell are public; the shell carries no data or credential.
- CORS is same-origin only, responses carry `nosniff`/`no-store`, and all server
  values are rendered with `textContent`/DOM nodes instead of `innerHTML`
  interpolation or inline `onclick` string handlers.
- WebChat uses `SessionRegistry::create_with_id`, removing the orphaned random-id
  session record per turn.

Deployment/CLI:
- Example config and onboarding generate/require a gateway token; the installer
  generates a random token instead of placeholder values; Dockerfile declares the
  required env var.
- `openclaw gateway status` sends the configured bearer token and reports `401`
  distinctly from offline.

### Install surface: matched vs. not matched (answer to "is install identical?")

No — the Rust install path is **not** byte-identical to the official one, and this
section records exactly where it matches, where it deliberately differs, and what
is missing. Official reference: `scripts/install.sh`, `scripts/install-cli.sh`,
`scripts/install.ps1`, `scripts/install-policy.sh`, and
`docs/install/installer.md` at the pinned checkout.

Matched (same documented contract):
- Config/state resolution: `OPENCLAW_CONFIG_PATH`, else
  `$OPENCLAW_STATE_DIR/openclaw.json`, with `OPENCLAW_HOME` then `HOME`
  (then `USERPROFILE`) fallback. Implemented in `openclaw-config::paths` with tests.
- Gateway credentials from `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`,
  with an explicit config value taking precedence.
- `openclaw onboard` writes `~/.openclaw/openclaw.json`, generates a token, sets
  `gateway.mode`-equivalent local binding, and keeps the DB inside the state dir.
- `openclaw gateway install` / `uninstall` exist as real service operations
  (systemd unit or launchd plist, `--user` support) and fail loudly on unsupported
  hosts instead of printing success.
- The Linux installer delegates service ownership to `openclaw gateway install`
  instead of hand-writing a unit, and requires a known architecture.
- Container sets `OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH` and persists state on
  a volume; no credential is baked into the image.

Not matched (real gaps, not waived):
- No hosted one-liner. The official entrypoints are
  `https://openclaw.ai/install.sh` and `install.ps1`; this build has a local
  `crates/install-linux-arm64.sh` only. There is no published artifact to `curl`.
- No `install.ps1`, no `install-cli.sh` rootless-prefix flow, no FreeBSD path.
- No Node/Bun runtime provisioning or version gate (this is a native binary), so
  Node 24.16+/26.1+ checks, SQLite-link checks, npm 11.16+/12 `--allow-scripts`,
  pnpm/Corepack bootstrap, and `--runtime bun` pin verification have no analogue.
- No `--install-method npm|git`, `--version <tag>`, `--beta`, `--git-dir`,
  `--no-git-update`, `--verify`, `--verbose`, or `--dry-run` parity beyond the
  subset the local script implements.
- No `openclaw doctor --fix` upgrade repair, no service token-drift checks, no
  launchd/systemd `restart --safe` deferral, no update channel switching.
- No Windows Hub/desktop app, macOS `.dmg`, or Tauri installer.
- Service install has unit/plist rendering tests and a real refusal path, but has
  **not** been executed on Linux or macOS here; only the unsupported-host refusal
  and the generated text are proven.

So: the Rust install is a partial, source-only installer that follows the
documented path/credential contract and no longer fakes success, but it is not the
official setup and does not yet reach install parity.

### Command surface: what was added this round

Three commands previously answered with a hardcoded line or did not exist at all.
All three now have red-then-green tests against the real binary.

- `openclaw config` (official `docs/cli/config.md`): `get`, `set`, `patch`,
  `unset`, `file`, `schema`, `validate`, plus `--dry-run` and
  `OPENCLAW_CONFIG_READONLY`/`OPENCLAW_NIX_MODE` refusal. Values are JSON-typed
  (`64` → number, `true` → bool). Writes go through a temp file and rename.
  Tests: `openclaw-cli/tests/config_command.rs` (7 tests, 6 failed before).
- `openclaw uninstall` (official `docs/cli/uninstall.md`): `--service`, `--state`,
  `--workspace`, `--app`, `--all`, `--yes`, `--non-interactive`, `--dry-run`.
  `--non-interactive` without `--yes` is refused; no scope is an error rather than
  a silent success; `--app` reports "not applicable" off macOS.
  Tests: `openclaw-cli/tests/uninstall_command.rs` (5 tests, 3 failed before).
- `openclaw dashboard` (official `docs/cli/dashboard.md`): `--json`, `--no-open`,
  `--yes`. `--json` emits one object with the documented failure envelope
  (`{"ok":false,"error":{...},"reason":...}`) and exits non-zero when the Gateway
  is unreachable; unknown flags are rejected.
  Tests: `openclaw-cli/tests/dashboard_command.rs` (4 tests, 2 failed before).

Known remaining divergence in these three: `config` writes go straight to the file
rather than through a running Gateway's `config.patch` owner, and `dashboard` does
**not** issue the one-time owner pairing handoff (`browserUrl` bootstrap), so its
JSON reports `tokenIncluded: false` instead of implying a pairing link exists.

### P0 defects found by the install/setup audit and fixed

All were reproduced with a failing test first, then fixed, then re-run green.

- `openclaw uninstall --all` removed **nothing** and exited 0. The app scope
  returned early on non-macOS, so the documented full-removal command was a silent
  no-op. The app scope is now a reported skip and the other scopes proceed.
  Tests: `uninstall_command.rs` (`all_scope_removes_everything_*`).
- `openclaw uninstall --state` deleted workspace directories that the documented
  contract preserves unless `--workspace` is also selected. State removal now
  enumerates the state dir and keeps `workspace/`/`workspaces/` unless asked;
  `--workspace` also removes workspaces named in config.
  Tests: `state_scope_preserves_workspaces_*`, `workspace_scope_removes_*`.
- `openclaw onboard --install-daemon` printed "run ./install-linux-arm64.sh" and
  exited 0 without installing anything. It now installs the real service, fails
  non-zero when no service manager exists, accepts `--no-install-daemon`, and
  rejects unknown flags instead of ignoring them. Onboarding also stamps
  `gateway.mode: "local"`. Tests: `onboard_daemon.rs`.
- `resolve_config` (used by `doctor`, `gateway`, `pairing`) searched an undocumented
  `OPENCLAW_CONFIG` and a hardcoded `/etc/openclaw/config.toml` **before**
  `OPENCLAW_CONFIG_PATH`, so an operator's explicit path was silently ignored.
  Documented precedence now wins. Tests: `resolve_config.rs`.
- Service identity was `openclaw.service`; official tooling uses
  `openclaw-gateway.service` and cleans up a legacy `clawdbot-gateway.service`.
  Renamed in the writer and both removal lists. Tests: `service_identity.rs`.
- `gateway install` wrote a unit and printed "activate it with…" but never
  activated, then reported success. It now runs `systemctl enable --now` /
  `launchctl bootstrap` and treats failure as an install failure.
- `openclaw doctor` always exited 0 even with WARN/ERROR lines, so the documented
  upgrade-repair gate could never fire. It now exits non-zero and summarizes
  problems; the mixed `[1/4]`/`[3/5]` numbering is gone. Tests: `doctor_gate.rs`.

### Still open after this round (verified divergences)

- `gateway status` has no `--json`; the documented `service.loaded` contract that
  official installers parse is absent, and offline/unauthorized both exit 0.
- No `daemon` alias, and no `gateway start/stop/restart` subcommands.
- `doctor --fix` / `--non-interactive` / `--json` / `--lint` are not implemented;
  `doctor` still opens (and thus creates) a missing database instead of reporting
  it, so a read-only inspection can mask the problem it is diagnosing.
- `OPENCLAW_PROFILE` is not implemented, so profile-scoped state and service
  identity are absent; every command acts on the default installation.
- Read-only config (`OPENCLAW_CONFIG_READONLY`) is enforced by `config` writers but
  not by `onboard`, which still writes the file and rotates the token.
- The state-ownership check reads a `gateway.pid` marker that no crate writes, so
  `uninstall --state` cannot detect a running Gateway.
- No `backup`/`restore`; the documented pre-uninstall archive step does not exist.
- Installer: no `--onboard`/`--no-onboard`, no `--json` NDJSON contract, and the
  rustup bootstrap is an unverified remote script.
- Docker entrypoint never onboards and the default DB path is relative, so state
  lands outside the declared volume.

### DM pairing: matched vs. still divergent

Official reference: `docs/channels/pairing.md`, `docs/cli/pairing.md`.

Matched now (each rule has a test in `openclaw-state/tests/pairing.rs`):
- 8-character uppercase codes from an alphabet excluding `0 O 1 I`
  (was: 6 characters taken from a UUID suffix, so it could contain ambiguous
  characters and the wrong length).
- 1-hour expiry: expired codes are refused and no longer occupy the pending cap
  (was: no expiry at all, so a code stayed valid forever).
- 3 pending requests per channel account (was: unlimited).
- Channel **and account** scoping for requests and approvals; approving on one
  account does not admit the sender on another (was: channel only).
- A repeat message from the same sender reuses the live request and does not
  re-send the pairing notice (`created` flag; was: the notice was re-sent on every
  message).
- Approve only transitions a live `pending` row; a second approval reports "not
  found" instead of a fresh success.
- Dismiss exists and is not a block (the sender can request again).
- CLI: positional channel, `--channel`, `--account` (blank rejected), `--notify`,
  `--json`, and the bare-code shorthand when exactly one channel has requests.
- Schema migration: an older `pairings` table without `account_id` is upgraded in
  place and its rows become the `default` account
  (`openclaw-state/tests/migration.rs`). This was a real crash on existing
  databases: `no such column: account_id`.

Still divergent / absent (open, not waived):- Storage location and table names differ from upstream: upstream uses
  `~/.openclaw/state/openclaw.sqlite` with `channel_pairing_requests` and
  `channel_pairing_allow_entries`; this build uses a `pairings` table in the
  configured database. Legacy-file import (`<channel>-pairing.json`,
  `<channel>-<account>-allowFrom.json`) via `doctor --fix` does not exist.
- `--notify` is parsed and reported, but no message is actually delivered because
  the CLI has no channel transport.
- Owner bootstrap (`commands.ownerAllowFrom`) on first approval is absent; there is
  no command-owner concept at all yet.
- Control UI has approve only — no dismiss action, no "notify requester" checkbox,
  no "make first command owner" checkbox, no account/peer filtering.
- Node/device pairing (`openclaw devices`, `openclaw nodes`, setup codes, QR,
  bootstrap tokens, 5-minute device request expiry, trusted-CIDR auto-approve) is
  entirely absent. Only the DM half of pairing exists.
- `dmPolicy: "open"` is treated as allow-everyone; upstream requires the effective
  allowlist to contain `*` and keeps concrete `allowFrom` entries restrictive.
- Access groups (`accessGroup:<name>`) are not supported.

### Round 2 defects found by the gateway + pairing audits and fixed

- `openclaw gateway stop` / `restart` **started a Gateway**. Every unrecognized
  subcommand fell through to `run_gateway`, so `stop` blocked the terminal and
  `restart` died on EADDRINUSE. Lifecycle names now fail loudly and unknown
  subcommands exit 2. Tests: `gateway_subcommands.rs` (reproduced with a *valid*
  config; without one, validation masked the bug).
- `openclaw gateway --port/--token` were silently ignored (unknown tokens were
  skipped), so `--port 19001` bound 18789 and `--token` never authenticated.
  `--port`, `--bind`, `--token`, `--password` are now applied and unknown flags
  are rejected. Tests: `gateway_flags.rs`.
- No WebSocket `Origin` check. WebSocket is not subject to CORS, so any web page
  could open the Gateway. Loopback origins are allowed, `OPENCLAW_CONTROL_UI_ORIGIN`
  adds one explicit origin, native clients (no Origin) still connect.
  Tests: `origin.rs`.
- Telegram DM gate treated `disabled` as pairing (so a silenced bot sent codes),
  treated `open` as public regardless of `allowFrom`, and ignored the account id
  (approvals leaked between accounts). All three fixed, and the pending-cap case
  now stays silent as documented. Tests: `channel_policy.rs` + `pairing.rs`.
- `/api/pairings` serialized the pairing **code** (the approval secret) to the
  browser, had no dismiss endpoint, and ignored `accountId` because the body struct
  lacked `rename_all = "camelCase"` — so a cross-account approve succeeded. The
  listing now returns an opaque id, dismiss exists, and account scope is enforced.
  Tests: `pairing_api.rs`.
- Pairing codes were generated from a time-seeded xorshift PRNG. Now drawn from
  `uuid` v4 (OS CSPRNG) over the 32-symbol documented alphabet, with insert-collision
  retry.

### Round 3: protocol parity (largest remaining blocker)

The handshake was rewritten against the real schemas, not guessed.

- `openclaw-protocol` now declares `PROTOCOL_VERSION = 4`,
  `MIN_CLIENT_PROTOCOL_VERSION = 4`, `MIN_NODE_PROTOCOL_VERSION = 3`
  (`packages/gateway-protocol/src/version.ts`).
- `ConnectParams` accepts `minProtocol`/`maxProtocol` (plus the deprecated scalar
  `protocol` for one release), `client`, `caps`, `commands`, `permissions`,
  `role`, `scopes`, `auth{token,password,bootstrapToken,deviceToken}`, `device`,
  `locale`, `userAgent` — matching `ConnectParamsSchema`.
- The server sends `connect.challenge` with `nonce` + integer `ts` **before** any
  client frame, as `docs/gateway/protocol/handshake.md` requires.
- `hello-ok` now carries every block `HelloOkSchema` marks required: `server`
  (`version`, `connId`), `features` (`methods`, `events`), `snapshot`
  (`presence`, `health`, `stateVersion{presence,health}`, `uptimeMs`,
  `configPath`, `stateDir`, `authMode`), `auth` (`method`, `role`, `scopes`,
  `roleAllowsAdmin`), `policy` (`maxPayload`, `maxBufferedBytes`,
  `tickIntervalMs`).
- Protocol range mismatch returns `PROTOCOL_MISMATCH` with
  `clientMinProtocol`/`clientMaxProtocol`/`expectedProtocol`/`minimumProtocol`/
  `reloadRequired` details.
- Password mode now authenticates from `connect.params.auth.password` instead of
  only `auth.token`.

Scope authorization (was entirely absent):
- `ConnectionScopes` carries the granted set; `dispatch` calls `scope_for` before
  every handler and returns `FORBIDDEN` with `details.code = "MISSING_SCOPE"`.
  Unknown methods default-deny with `INVALID_REQUEST` / `METHOD_NOT_FOUND`.
- `Scope` grew a `Named` variant; the table now uses the real 10-scope set
  (`operator.pairing`, `operator.approvals`, `operator.questions`, `operator.talk`,
  `operator.talk.secrets`, `operator.sessions.read/write`), fixing the 34
  misclassified rows. `channels.pairing.approve` was missing and is now present.
- `write` implies `read`; `admin` implies every operator scope; empty scopes grant
  nothing.

Events and durability:
- `tick` is pushed on `ping_interval_secs` and `shutdown` is sent before the socket
  closes, both with the documented payload shapes.
- Sessions persist to a `sessions` table (`upsert_session`/`load_sessions`) and the
  CLI hydrates the registry at startup, so `sessions.list` survives a restart.
  WebChat writes through on create and on each turn.

Tests added: `handshake.rs` (5), `authorization.rs` (7), `events.rs` (2),
`persistence.rs` (2). All were red before the corresponding fix.

### Round 4: RPC response shapes, status contract, dashboard honesty

All four fixes were red-then-green against the documented contracts.

- `sessions.list` rows now carry `key`, `sessionId`, `updatedAt` (epoch ms) and
  `createdAt`, so the Control UI can render a roster instead of `undefined`
  (`docs/gateway/protocol/rpc-session-control.md:86`).
- `sessions.get` returns `{ messages }` from the stored transcript; session
  metadata moved to the new `sessions.describe` handler, exactly as
  `rpc-session-control.md:117` splits them.
- `config.get` returns the live config plus `hash` and `configRevisionHash` (the
  write conflict-guard tokens) and the resolved path, instead of `{}`.
- `gateway status` gained the installer contract: `--json` emits one object with
  `service.loaded`, `gateway.reachable`, `gateway.probed`, `gateway.port`, and
  `--port`/`--token`/`--password`/`--no-probe`/`--deep`/`--require-rpc` are parsed.
  Unknown flags exit 2 and an unreachable Gateway exits 1, so scripts can branch.
  (`scripts/install-cli.sh:1234-1261`, `docs/cli/gateway/query.md:212-272`.)
- `dashboard --json` no longer reports `ok: true` with a null bootstrap expiry. It
  now returns `ok:false` with `reason: "pairing_handoff_unavailable"`, because this
  build cannot mint the one-time owner bootstrap that `docs/cli/dashboard.md`
  documents. `--no-open` still prints the URL.

Supporting work:
- `TranscriptReader` trait decouples the Gateway from the SQLite store;
  `SqliteStateStore::transcript_messages` reads committed turns in chronological
  order with a limit.
- `Gateway::with_transcripts` wires that reader into the dispatcher; the CLI
  connects it to the real store.

Tests added: `shapes.rs` (4), `gateway_status.rs` (6), `dashboard_honesty.rs` (5),
`transcript.rs` (3).

REA note: `analyze_javascript_application` was run on the integrity-verified release
package for `dist/sessions-read-*.mjs` (Evidence
`ev_c3d3d860a67bdad28dc5d7057c17c7f20f3a1f78e8f8ff419f76bf2497ec6b7b`). Coverage was
`complete-within-view` for the selected files only; 10,955 inventoried files stayed
outside scope, so the authoritative contracts above were read from the pinned source
rather than inferred from the bundle.

### Still open (verified, unchanged by round 4)

- Control UI is still a bespoke HTTP API on port 18790, not the Gateway WS protocol;
  `dist/control-ui` cannot attach. `/healthz` lives only there.
- The one-time owner pairing handoff still does not exist (now reported honestly
  instead of faked).
- Device/node pairing absent end to end.
- No `channels.pairing.*` handlers in the Gateway; the CLI writes SQLite directly
  with no state-ownership check.
- No `commands.ownerAllowFrom`.
- 58 canonical methods still missing; the table is hand-maintained.
- `gateway start/stop/restart`, `daemon`, `backup`, `update`, `plugins`, `agents`,
  `tui` remain `MISSING` in `parity-commands.tsv`.

- Control UI is still a bespoke HTTP API on port 18790, not the Gateway WS protocol;
  `dist/control-ui` cannot attach. `/healthz` lives only there.
- `dashboard --json` reports `ok: true` without the one-time owner bootstrap.
- `gateway status` probes the UI HTTP port and ignores `--json`.
- `config.get` returns `{}`; no `config.patch`/`baseHash` conflict guard.
- `sessions.get` returns session metadata instead of `{messages}`; `sessions.list`
  rows lack `key`.
- Device/node pairing absent end to end (tables, handlers, `devices`/`nodes`/`qr`,
  setup codes, bootstrap tokens).
- No `channels.pairing.*` handlers in the Gateway; the CLI still writes SQLite
  directly with no state-ownership check.
- No `commands.ownerAllowFrom`, so first-owner bootstrap cannot exist.
- 58 canonical methods still missing from the table; the table is hand-maintained
  rather than generated from `CORE_GATEWAY_METHOD_SPECS`.
- `gateway start/stop/restart`, `daemon`, `backup`, `update`, `plugins`, `agents`,
  `tui` and the rest of the `MISSING` rows in `parity-commands.tsv`.

- The Gateway handshake is a different protocol: no `connect.challenge`,
  `protocol: 1` instead of `minProtocol`/`maxProtocol` 4, and a `hello-ok` missing
  `server`/`features`/`snapshot`/`policy`/`auth`. An official client cannot connect.
- No method is authorized by scope: `scope_for` exists but the dispatcher never
  calls it, so `sessions.end` and `config.get` need no scope at all.
- The scope table has 3 levels instead of 10 and misclassifies 34 methods
  (device/node pairing, talk, approvals are all marked `read`).
- The Control UI is a bespoke HTTP API on port 18790, not the Gateway WS protocol,
  so the official `dist/control-ui` cannot attach. `/healthz` lives only there.
- `dashboard --json` reports `ok: true` with `browserBootstrapExpiresAtMs: null`
  and no bootstrap fragment — the documented one-time owner handoff does not exist.
- `gateway status` probes the UI HTTP port (not WS), ignores all flags including
  `--json`, and reports OFFLINE when the Control UI is disabled.
- Sessions are in-memory only (`DashMap`), so every restart empties
  `sessions.list`; no server-pushed events (`tick`, `shutdown`, `sessions.changed`)
  are emitted; `config.get` returns `{}`.
- Device/node pairing is entirely absent: no `device_pairing_*` tables, no
  `device.pair.*`/`node.pair.*` handlers, no `devices`/`nodes`/`qr` CLI, no setup
  codes. The node host is client-only and keeps its device token in memory.
- No `channels.pairing.*` Gateway methods; the CLI writes the live SQLite file
  directly with no state-ownership check.
- No `commands.ownerAllowFrom` config key, so first-owner bootstrap cannot exist.

Proof logs (generated, not committed): `target/gateway-access-red.log`,
`target/gateway-access-green.log`, `target/config-auth-red.log`,
`target/config-auth-green.log`, `target/dashboard-auth-red.log`,
`target/dashboard-green.log`, `target/parity-after-auth.log`,
`target/parity-final-tests.log`, `target/paths-red.log`,
`target/env-auth-red.log`, `target/env-auth-container.log`,
`target/gateway-install-red.log`, `target/gateway-install-green.log`,
`target/installer-unit-red.log`, `target/installer-unit-green.log`,
`target/container-red.log`, `target/container-green.log`,
`target/onboard-red.log`, `target/onboard-green.log`,
`target/parity-install-tests.log`. Red runs were observed before each fix; the
dashboard auth gate was additionally re-broken to confirm its test fails.
Final workspace run: `cargo test --workspace --offline` → native exit code `0`,
38 suites, 0 failures.

## Remaining proof gaps

### The comparison loop

`crates/parity-commands.tsv` lists every documented command with a status
(`MATCH` / `PARTIAL` / `MISSING`) and a note naming the gap.
`openclaw-cli/tests/parity_table.rs` enforces it in both directions:

- a `MATCH`/`PARTIAL` row whose command the CLI does not expose fails the build;
- a `MISSING` row whose command the CLI *does* expose also fails, so implementing
  a command forces its row to be re-graded with evidence.

That second rule is what makes the loop converge: the table can neither over-report
nor under-report the surface, and nothing documented can be silently absent.
Current table: 42 rows, of which 18 are `MISSING` and are the open work queue.

Only `x86_64-pc-windows-gnu` is installed in this environment. Linux ARM64 build/run,
real Telegram/provider conversations, official Control UI compatibility, complete
plugin behavior, and companion apps remain unverified. Existing tests include
substantial inherited gateway-client/node-host coverage and must not be reported
as tests of newly implemented parity.

Still missing and not claimed: upstream handshake (`minProtocol`/`maxProtocol`,
`connect.challenge`, protocol 4, role/scope model, full `hello-ok`), the real
method/event catalog and per-scope policy, shared agent runtime (tool calls,
streaming, cancellation, approvals, sandboxing), channel inbound lifecycles,
plugin/skill runtimes, cron scheduling, memory isolation, MCP/ACP, companion apps,
and Linux ARM64 execution. The auth work above closes specific boundary defects; it
does not narrow the feature target.
