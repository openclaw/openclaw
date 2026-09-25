---
summary: "Synthetic Slack-class channel plugin for deterministic OpenClaw QA scenarios"
title: "QA channel"
read_when:
  - You are wiring the synthetic QA transport into a local or CI test run
  - You need the bundled qa-channel config surface
  - You are iterating on end-to-end QA automation
---

`qa-channel` is a repo-local synthetic message transport for automated OpenClaw QA (`extensions/qa-channel`, private package, excluded from packaged installs). It is not a production channel - it exists to exercise the same channel plugin boundary used by real transports while keeping state deterministic and fully inspectable.

## What it does

- Slack-class target grammar:
  - `dm:<user>`
  - `channel:<room>`
  - `group:<room>`
  - `thread:<room>/<thread>`
- Shared `channel:` and `group:` conversations are surfaced to agents as group/channel room turns, so they exercise the same visible-reply and message-tool routing policy used by Discord, Slack, Telegram, and similar transports.
- Message sends that omit `target` and `to` preserve the inbound conversation kind: direct, group, or channel.
- Sends in a threaded inbound conversation inherit its thread, including sends to the same explicit root target. `topLevel: true` or `threadId: null` suppresses implicit thread and reply inheritance. Explicit thread targets, thread IDs, and `replyTo` values are preserved.
- HTTP-backed synthetic bus for inbound message injection, outbound transcript capture, thread creation, reactions, edits, deletes, and search/read actions.
- Media-bearing streamed replies deliver attachments and the current tool trace together. A later identical text-only final is suppressed only when its caption and tool trace were already delivered successfully.
- Host-side self-check runner that writes a Markdown report to `.artifacts/qa-e2e/`.

## Config

```json
{
  "channels": {
    "qa-channel": {
      "baseUrl": "http://127.0.0.1:43123",
      "botUserId": "openclaw",
      "botDisplayName": "OpenClaw QA",
      "allowFrom": ["*"],
      "pollTimeoutMs": 1000
    }
  }
}
```

Account keys:

- `enabled` - master toggle for this account.
- `name` - optional display label.
- `responsePrefix` - automatic reply prefix; account overrides win. Accepts a literal, `"auto"` for the agent identity name, a template such as `"[{model}]"`, or `""` to disable an inherited prefix.
- `baseUrl` - synthetic bus URL. The account counts as configured once this is set.
- `botUserId` - synthetic bot user id used in target grammar (default: `openclaw`).
- `botDisplayName` - display name for outbound messages (default: `OpenClaw QA`).
- `pollTimeoutMs` - long-poll wait window. Integer between 100 and 30000 (default: 1000).
- `mediaMaxMb` - per-attachment limit in MiB for inbound bytes and outbound files. Named accounts override the channel root, then `agents.defaults.mediaMaxMb` supplies the fallback. If none is set, existing media-store and loader defaults apply. An oversized inbound attachment becomes an unavailable-attachment notice for the model. The channel loads each outbound batch before publishing it, so a failed attachment prevents that batch from being sent. Shared reply preparation can first remove oversized local files and retain valid attachments with a warning.
- `allowFrom` - sender allowlist (user ids or `"*"`; default: `["*"]`). DMs are
  always `open` policy; allowlisted group policy also uses these synthetic
  sender ids.
- `groupPolicy` - shared-room policy: `"open"` (default), `"allowlist"`, or
  `"disabled"`.
- `groupAllowFrom` - optional shared-room sender allowlist. When omitted under
  `"allowlist"`, QA Channel falls back to `allowFrom`.
- `groups.<room>.requireMention` - require a bot mention before replying in a
  specific group/channel room (default: false). `groups."*"` sets the default;
  per-room `tools` / `toolsBySender` set tool policy overrides.
- `defaultTo` - fallback target when none is supplied.
- `actions.messages` / `actions.reactions` / `actions.search` / `actions.threads` - per-action tool gating.

Multi-account keys at the top level:

- `accounts` - record of named per-account overrides keyed by account id.
- `defaultAccount` - preferred account id when multiple are configured.

## Runners

Host-side self-check (writes a Markdown report under `.artifacts/qa-e2e/`):

```bash
pnpm qa:e2e
```

This routes through `qa-lab`, starts the in-repo QA bus, boots the `qa-channel` runtime slice, and runs a deterministic self-check.

Full repo-backed scenario suite:

```bash
pnpm openclaw qa suite
```

The isolated `channel-participant-identity-inspection` scenario enables
execution identity before startup, exercises DM, group, senderless, same- and
mixed-participant collect paths, proves an ingress rejection creates no audit
rows, and compares JSON plus human CLI inspection across Gateway restart:

```bash
pnpm openclaw qa suite --scenario channel-participant-identity-inspection
```

Runs scenarios in parallel against the QA gateway lane. See [QA overview](/concepts/qa-e2e-automation) for scenarios, profiles, and provider modes.

Docker-backed QA site (gateway + QA Lab debugger UI in one stack):

```bash
pnpm qa:lab:up
```

Builds the QA site, starts the Docker-backed gateway + QA Lab stack, and prints the QA Lab URL. From there you can pick scenarios, choose the model lane, launch individual runs, and watch results live. The QA Lab debugger is separate from the shipped Control UI bundle.

## Installed-candidate fixtures

Private QA plugins remain excluded from the public OpenClaw package. To exercise
an installed candidate, build their Gateway-only artifacts in a separate fixture
workspace. The fixture profile keeps QA Lab's Gateway hooks, tools and providers,
but leaves its scenario runner and CLI in the tooling checkout. QA Channel carries
its pure bus protocol implementation; public SDK imports still belong to the
installed candidate.

From a complete, dependency-ready tooling checkout at the committed revision
being tested:

```bash
fixture_root="$(mktemp -d)"
git archive HEAD extensions/qa-lab extensions/qa-channel | tar -x -C "$fixture_root"
mkdir "$fixture_root/artifacts"

for plugin in qa-lab qa-channel; do
  node scripts/lib/plugin-npm-runtime-build.mjs \
    "$fixture_root/extensions/$plugin" --qa-gateway-fixture
  OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES=1 \
    node scripts/lib/plugin-npm-package-manifest.mjs \
    --run "$fixture_root/extensions/$plugin" --qa-gateway-fixture -- \
    npm pack --pack-destination "$fixture_root/artifacts"
done
```

The builder writes only the copied packages' `dist` directories. The manifest
owner restores their source metadata after packing and includes the canonical
QA Channel config schema. Dependency bundling is required for this portable
fixture recipe: the profile alone does not install or bundle `typebox` and `zod`.
Do not copy checkout `node_modules` links or overwrite another run's generated
plugin output.

Use the existing `runQaSuite` API with the tooling checkout as `repoRoot` and an
explicit `sutOpenClawCommand` pointing to the installed candidate's runtime and
`dist/index.js`, with `usePackagedPlugins: true`. Extract the reviewed artifacts
into an isolated fixture directory and add those package paths through the API's
`mutateConfig` callback to `plugins.load.paths`, preserving the other config
fields. That callback runs for each fresh child before the candidate performs
its own auth bootstrap and update repair. Local origin and capability-consent
rules still apply; fixtures do not acquire official package trust.

Keep the installed package unchanged. Do not set `OPENCLAW_DEV_SOURCE_ROOT` or
replace its bundled plugin/SDK roots with the tooling checkout. Record both
revisions and verify fixture peer/API requirements and emitted host imports
against the **installed candidate**, not just the tooling version. Required
proof includes actual candidate Gateway/CLI images, candidate-owned SDK
resolution, the unchanged scenario results and complete child cleanup. A source
QA pass alone does not establish installed-package compatibility.

## Related

- [QA overview](/concepts/qa-e2e-automation) - overall stack, transport adapters, the Matrix live lane, and scenario authoring
- [Personal agent benchmark pack](/concepts/personal-agent-benchmark-pack) - the scenario pack that runs on this channel
- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Channels overview](/channels)
