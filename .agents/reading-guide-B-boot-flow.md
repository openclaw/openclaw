# Reading Guide B — Boot Flow: From CLI Command to Running Gateway

A map, not a walkthrough. Open each file just long enough to answer the listed questions, then move on. Do not try to understand each implementation in one sitting.

## Stop 1 — Bin entry point

- `openclaw.mjs`
- Role: Node runtime guard + dispatch into the TypeScript CLI main.
- What to look for:
  - Does this file do real work, or is it a thin shim into `src/cli/run-main.ts`?
  - Where does Node version / path warm-up actually happen?
  - Which env vars does it care about before dispatch?

## Stop 2 — CLI dispatch + two command surfaces

- `src/cli/run-main.ts` — main entry invoked by the bin.
- `src/cli/command-catalog.ts` — enumerates routed command ids; start here to see the shape of the command set.
- `src/cli/command-bootstrap.ts` — how commands register and get wired.
- `src/cli/gateway-cli/run.ts` — the `gateway run` command entry (daemon-style boot).
- `src/cli/progress.ts` — shared CLI progress UI (called throughout boot).
- No dedicated `onboard` command exists; the closest on-the-CLI surface is the update/wizard flow in `src/cli/update-cli/wizard.ts`. True onboarding logic lives on the gateway side (see Stop 3).
- What to look for:
  - How is a raw argv turned into a command invocation?
  - Which command triggers "start the gateway"?
  - Where does progress rendering hook into slow boot steps?

## Stop 3 — Onboarding surface

- `docs/start/wizard.md` — user-visible onboarding story.
- `docs/start/onboarding-overview.md` — higher-level narrative.
- `src/gateway/server-methods/wizard.ts` — gateway-side wizard RPC handler.
- `src/gateway/protocol/schema/wizard.ts` — wire schema for wizard steps.
- Plugin SDK seams: `src/plugin-sdk/setup.ts`, `src/plugin-sdk/channel-setup.ts`, `src/plugin-sdk/provider-setup.ts`, `src/plugin-sdk/optional-channel-setup.ts`, `src/plugin-sdk/setup-tools.ts`, `src/plugin-sdk/self-hosted-provider-setup.ts`.
- What to look for:
  - Which setup responsibilities belong to core vs to a plugin?
  - How does a plugin declare "I need these questions asked"?
  - What's the contract the wizard RPC fulfils?

## Stop 4 — Gateway boot + daemon install + health

- `src/gateway/boot.ts` — gateway process bootstrap.
- `src/gateway/client-bootstrap.ts` — companion client/session bootstrap.
- `src/gateway/server-plugin-bootstrap.ts` — plugin wiring during server startup.
- `src/cli/daemon-cli/install.ts` + `install.runtime.ts` — launchd/systemd install path (lives under CLI, not `src/gateway/`).
- `src/cli/daemon-cli/lifecycle.ts`, `src/cli/daemon-cli/status.ts`, `src/cli/daemon-cli/restart-health.ts` — daemon lifecycle + health probes.
- `src/gateway/channel-health-monitor.ts`, `src/gateway/channel-health-policy.ts`, `src/gateway/server.health.test.ts` — runtime health for channels.
- What to look for:
  - What's done once at boot vs on every reload?
  - Where does "install me as a system service" diverge between macOS and Linux?
  - Which health signals can keep the daemon alive vs force restart?

## Stop 5 — Config contract

- `docs/gateway/configuration.md` — the spoken contract.
- `docs/gateway/configuration-reference.md` — generated-style reference.
- `src/config/config.ts` — root config loader/shape (there is no `config-schema.ts` under `src/config/`; schema-named modules live in `src/channels/plugins/config-schema.ts`, `src/plugins/config-schema.ts`, `src/plugin-sdk/config-schema.ts`).
- `src/config/types.openclaw.ts` — root `OpenClawConfig` type.
- `src/config/defaults.ts` — code-side defaults.
- What to look for:
  - Which defaults live in code vs in docs vs in generated metadata?
  - What's the retired-key compatibility path?
  - Where does validation happen relative to boot order?

## Stop 6 — Security defaults

- `docs/gateway/security.md` — not present; closest real doc is `docs/gateway/authentication.md` plus `docs/gateway/trusted-proxy-auth.md` and `docs/gateway/secrets.md`. Takeaway to form: how is an incoming request authenticated before anything else runs?
- `docs/gateway/sandboxing.md` — takeaway to form: what runs sandboxed by default, and what must opt in?

## 3 friction questions to collect while reading

1. Which config defaults live in code (`src/config/defaults.ts`) vs in docs (`docs/gateway/configuration-reference.md`), and which source wins on conflict?
2. At what point in boot does the gateway become reachable — before or after plugin setup finishes?
3. Which onboarding steps can a third-party plugin influence today, and which are still core-only?
