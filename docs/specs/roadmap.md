# Roadmap

Inferred from `docs/refactor/`, `docs/experiments/`, and recent `CHANGELOG.md` entries (current released version: **2026.1.31**). When in doubt, the design docs under `docs/refactor/` are the source of truth — this file is a pointer.

## Now

- **Plugin SDK + runtime refactor** — every messaging connector becomes a plugin (bundled or external) against one stable API; no plugin imports from `src/**` directly. See `docs/refactor/plugin-sdk.md`.
- **Outbound session mirroring (#1520)** — outbound sends mirror into the *target* channel session key, create session entries on outbound, and align thread/topic scoping with inbound. Core + plugin channel routing already updated; covering bundled extensions and tests. See `docs/refactor/outbound-session-mirroring.md`.
- **Channel + provider polish** — ongoing reliability work across Telegram (shared pairing store, draft streaming partials), Discord (PluralKit proxied senders, directory resolution), Slack, BlueBubbles attachment debounce, MiniMax/Kimi/OpenRouter auth + attribution headers, Moonshot endpoint clarifications. See recent CHANGELOG entries 2026.1.29–2026.1.31.

## Next

- **Clawnet** — unify the node ↔ gateway ↔ operator-client protocol: one transport, scoped roles (operator/agent/device/admin), unified pairing + approvals, TLS pinning, stable IDs with cute slugs. See `docs/refactor/clawnet.md`.
- **Exec host routing + headless runner** — `exec.host` + `exec.security` to route execution across sandbox / gateway / node with per-agent policy, ask modes, allowlists, and a headless runner service with optional UI IPC. Defaults stay safe (no cross-host exec without explicit opt-in). See `docs/refactor/exec-host.md`.
- **Strict config validation** — reject unknown config keys (root + nested), reject plugins without a schema, remove legacy auto-migration on load (migrations only via `doctor`), auto-run doctor dry-run on startup. See `docs/refactor/strict-config.md`.
- **Onboarding + config protocol** — shared wizard surface across CLI, macOS app, and Web UI via Gateway RPC (`wizard.start`/`next`/`cancel`/`status`, `config.schema`). See `docs/experiments/onboarding-config-protocol.md`.
- **Targeted hardening plans** — cron-add hardening, group-policy hardening, OpenResponses gateway. See `docs/experiments/plans/`.

## Later

- **Model config proposal** — see `docs/experiments/proposals/model-config.md`.
- **Memory research direction** — vector + hybrid retrieval evolution; see `docs/experiments/research/memory.md` and `extensions/memory-core` / `extensions/memory-lancedb`.
- **Formal-conformance expansion** — the `formal-conformance.yml` workflow validates against the `clawdbot-formal-models` repo on PRs; more surface area can be brought under it.

## Parked

- **Multi-tenant / SaaS hosting** — out of scope; OpenClaw is a single-operator product (see `mission.md`). Hosted-backend ideas are deferred to keep the trust boundary at the operator's own host.
- **Open inbound DMs by default** — explicitly rejected. Gateway auth `"none"` was removed in 2026.1.25 and DM `pairing` is the default; `dmPolicy="open"` requires an explicit opt-in plus `"*"` in `allowFrom`.
- **Streaming partials on external chat surfaces (WhatsApp/Telegram/etc.)** — parked for UX + safety reasons; only final replies go out.
- **Carbon dependency upgrades** — frozen by policy (`@buape/carbon@0.14.0`); revisit only if forced by an upstream break.
