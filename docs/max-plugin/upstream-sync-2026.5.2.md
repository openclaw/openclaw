# Upstream 2026.5.2 — Impact Analysis on MAX Plugin Plan

Investigation, not code. Sibling to `docs/max-plugin/plan.md` (PR #2 on branch
`docs/max-plugin-plan`). Asks one question: do upstream changes around the
`2026.5.2` line invalidate any part of that plan, and what should the merge
order be?

The companion plan PR is https://github.com/mefodiytr/openclaw/pull/2.

> Branch note. The session's system instructions pin development to
> `claude/analyze-upstream-impact-6JHYm`, so this analysis lives there even
> though the original task framing suggested `analysis/upstream-2026.5.2-impact`.
> Functionally identical; only the branch name differs.

## §1 Versions

| Item | Value |
|---|---|
| Fork main tip | `39bc94e4` — `fix(onboarding): trust official optional plugin installs` (`2026-05-03 00:22:09 -0700`) |
| `package.json:3` on fork main | `"version": "2026.5.3"` (in-development; not yet released) |
| Last released `## <version>` header in `CHANGELOG.md:112` | `2026.5.2` |
| Current `## Unreleased` block on fork main | seven `### Changes` entries, ~40 `### Fixes` entries — these are the post-2026.5.2 commits that will become `2026.5.3` |
| PR #2 head (`docs/max-plugin-plan`) | `c1a80f86` — based on fork main `39bc94e4` |
| PR #2 vs fork main | adds only `docs/max-plugin/plan.md` (1098 lines), no other touched files |
| Configured upstream remote on this checkout | none — only `origin = mefodiytr/openclaw` is wired |
| Tags | none locally |

The repo treats fork main as the working trunk. There is no separate
`openclaw/openclaw` upstream remote and no `v2026.5.2` tag locally, so the
"upstream 2026.5.2 vs fork" diff cannot be computed from git directly. The
substitute used here is the `## Unreleased` section of `CHANGELOG.md` — the
authoritative list of commits that landed after the `2026.5.2` release header.

Practically: the plan in PR #2 was authored on a fork whose main is
**one in-development cycle ahead of `2026.5.2`**, and that delta is fully
captured by the `Unreleased` changelog entries.

- Commits behind `2026.5.2` (released line): **0** (fork is ahead).
- Commits ahead of `2026.5.2`: roughly the count of `Unreleased` bullets
  (~50, single-PR-per-bullet approximation). Days ahead: ~0–1 (the
  `2026.5.2` release line and the plan PR sit within the same ~24h
  window based on commit timestamps).

## §2 Changelog summary (2026.5.x)

### `2026.5.2` highlights (`CHANGELOG.md:112-411`)

- External plugin installation is the dominant theme: ClawHub vs npm cutover,
  diagnostics/onboarding/doctor repair touching install records, ClawPack
  artifacts, signed install provenance, `clawhub:` spec routing.
- Performance work in gateway startup, `sessions.list`, task maintenance,
  prompt prep, plugin loading, filesystem hot paths.
- Control UI / WebChat reliability fixes (sessions, cron, WebSocket
  keepalives, slash commands, iOS PWA, selection contrast).
- Channel/provider fixes: Telegram topic commands and networking,
  Discord delivery and startup edges, Slack DMs and routing, Feishu
  Lark SDK bundling, voice-call routing, web search providers
  (Brave/SearXNG/Firecrawl/Gemini), OpenAI-compatible TTS/Realtime.
- Plugin-SDK surface stays stable. The two notable SDK touch-points:
  - `Plugin SDK: re-export isPrivateIpAddress from plugin-sdk/ssrf-runtime`
    — additive, restoring source-checkout builds.
  - `Plugins/tools: enforce contracts.tools as the manifest ownership
    contract` — this is a manifest-validation tightening, not a runtime
    type change. The MAX plan already declares an explicit manifest, so
    this is a hint to make sure `openclaw.plugin.json` lists the channel
    contract correctly when we add it.
- "Beta publish prep" rolls Nextcloud Talk, Telegram-adjacent plugins,
  Matrix, Mattermost, Google Chat, LINE through publishable-package
  dist trees. The bundled source layout we copy from is unchanged.
- `Plugins/source checkout: load bundled plugins from the extensions/*
  pnpm workspace tree in source checkouts` — again, the layout we
  reference. Confirms `extensions/<id>` is still the canonical location
  for new bundled channels (which is what plan §2 already assumes).

### `Unreleased` post-2026.5.2 highlights (`CHANGELOG.md:1-111`)

Distinct themes vs `2026.5.2`:

- New bundled `file-transfer` plugin (highlight). Does not touch any of
  the channel/SDK files cited by plan.md.
- More plugin onboarding/install hardening (Manual setup, optional
  plugins, `plugins enable`/`plugins disable` config-write hygiene).
- `Channels/secrets: resolve SecretRef-backed channel credentials
  through external plugin secret contracts after the plugin split` —
  related to plan §5 (`channels.max-messenger.accounts.*.token` secret
  contract), but pattern-compatible: the secret-contract surface that
  Nextcloud Talk uses is the same one MAX would use.
- `Channels: keep Matrix and Mattermost bundled in the core package`
  — confirms the bundled-plugin path the plan picks.
- `Channels/setup: label installable channel picker hints as remote
  npm installs and hide remote install hints for bundled plugins`
  — informational; does not change channel-plugin shape.
- Plugin uninstall/install repair, beta update channel, registry
  fingerprinting — none touch the cited SDK adapter types.
- `Bonjour: disable LAN mDNS advertising after a repeated stuck-
  announcing recovery` — unrelated.
- A handful of CLI/agent fixes (devices approve scoping, agent
  delivery, Codex, models list) — unrelated to MAX surface.

No deprecations or breaking-change entries that touch the surfaces
the MAX plan references.

## §3 Files-of-interest diff

Each row reflects a citation target in `plan.md` and its current state
on fork main `39bc94e4`. Because PR #2 only adds `plan.md` and is based
on this exact commit, the verification target is unambiguous: the
referenced file:line ranges resolve against the same tree the plan was
authored against.

| File | Status | Impact on plan |
|---|---|---|
| `extensions/nextcloud-talk/src/channel.ts` | unchanged on fork main; full file present (200 lines) | none — every `channel.ts:NN` citation in plan §3.1 still resolves to the labelled construct. Verified rows: `:1, :2, :3, :4, :12` (imports), `:34-44` (meta), `:71` (id), `:74-81` (capabilities), `:82` (reload), `:83` (configSchema), `:84-96` (config), `:97` (approvalCapability), `:98` (doctor), `:99-120` (groups), `:121-129` (messaging), `:130-133` (secrets), `:135-152` (status), `:155-162` (pairing.text), `:163-166` (security), `:167-194` (outbound) |
| `extensions/nextcloud-talk/src/gateway.ts` | unchanged | none — `:1` createAccountStatusSink import, `:2` runStoppablePassiveMonitor import, `:14-43` `nextcloudTalkGatewayAdapter` block all resolve. File total 109 lines |
| `extensions/nextcloud-talk/src/inbound.ts` | unchanged (320 lines) | none — `:54-320` covers `handleNextcloudTalkInbound`; `:138-156` is the `resolveDmGroupAccessWithCommandGate` call; `:175-196` is the pairing branch (actual `pairing.issueChallenge` is at `:177`, broad citation still valid); `:264-287` is `core.channel.reply.finalizeInboundContext`; `:289-319` is `dispatchInboundReplyWithBase`. All resolve |
| `extensions/nextcloud-talk/src/monitor.ts` | unchanged (385 lines) | none — `:3-9` webhook-ingress imports, `:197-214` `payloadToInboundMessage`, `:228-385` `createNextcloudTalkWebhookServer` all resolve |
| `extensions/nextcloud-talk/src/setup-core.ts` | unchanged | none — `:1` ChannelSetupAdapter import, `:5-7` setup imports, `:8-15` setup-runtime imports, `:16` formatDocsLink, `:199-248` `nextcloudTalkSetupAdapter` all resolve |
| `extensions/nextcloud-talk/src/secret-contract.ts` | unchanged | none — `:1-8` imports, `:11-55` `secretTargetRegistryEntries` + `collectRuntimeConfigAssignments` resolve |
| `extensions/nextcloud-talk/src/types.ts` | unchanged | none — `:9-90` (account/config types) and `:151-161` (`NextcloudTalkInboundMessage`) resolve |
| `extensions/nextcloud-talk/src/accounts.ts` | unchanged | minor — plan cites `:1-7` for `account-core` imports (actual block is `:1-7`, closing `}` at `:7`), `:8` for `tryReadSecretFileSync` (matches), `:9-12` for text-runtime imports (matches) |
| `extensions/nextcloud-talk/src/config-schema.ts` | unchanged | minor off-by-one — plan §3.1 cites `:8` for `requireChannelOpenAllowFrom` from `extension-shared` but the import is on line `:9` (line `:8` is the closing `} from "openclaw/plugin-sdk/channel-config-schema"`). Cosmetic only — symbol still imports correctly from `extension-shared` |
| `extensions/nextcloud-talk/index.ts` | unchanged | none — `:1` `defineBundledChannelEntry` import, `:3-20` the call expression resolve exactly |
| `extensions/nextcloud-talk/openclaw.plugin.json` | unchanged (15 lines) | none — `:3-5` `activation.onStartup: false` resolves |
| `extensions/nextcloud-talk/package.json` | unchanged (60 lines) | none — `:1-60`, `:2` (`name: "@openclaw/nextcloud-talk"`), `:38-40` (alias array `"nc-talk"`, `"nc"`) resolve |
| `extensions/telegram/src/polling-session.ts` | unchanged (443 lines) | none — `:120-352` cited as supervisor-shape reference for §6.1.3/§6.1.6. Range covers `runUntilAbort()` and surrounding lifecycle/abort code. No drift |
| `extensions/telegram/src/bot-message-dispatch.ts` | unchanged (1422 lines) | none — `:114-400` cited as update-routing reference for §4. Region intact; routing dispatch types still anchored at `:114` |
| `extensions/telegram/src/channel.ts` | unchanged (1172 lines) | none — `:741` cited for `lifecycle.onAccountConfigChanged` token-change handling. Line `:741` exactly matches `onAccountConfigChanged: async ({...})` |
| `extensions/telegram/src/accounts.ts` | unchanged | none — `:117` cited for `apiRoot: accountCfg?.apiRoot` matches exactly |
| `extensions/telegram/openclaw.plugin.json` | unchanged (15 lines) | none — `:1-15`, `:3-5` (`activation.onStartup: false`) resolve |
| `extensions/telegram/package.json` | unchanged | none — `:18-20` (`extensions: ["./index.ts"]`), `:46-50` (`env.allOf: ["TELEGRAM_BOT_TOKEN"]`) resolve |
| `src/channels/plugins/types.adapters.ts` | unchanged (878 lines) | none — `:341` is `ChannelGatewayAdapter` declaration (exact); `:545` is `ChannelLifecycleAdapter` declaration (exact); `:238-312` covers `ChannelGatewayContext` (`abortSignal` at `:243`). Plan §6.1.3 lifecycle integration anchors are stable |
| `src/plugin-sdk/extension-shared.ts` | unchanged (253 lines) | none — `:69` is `runStoppablePassiveMonitor` declaration (exact). Plan §6.1.3/§6.1.6 supervisor wrapper still works |
| `docs/plugins/sdk-channel-plugins.md` | unchanged (707 lines) | none — `:91` (`approvalCapability` discussion), `:154-157` (`channelEnvVars`), `:160-164` (`setupEntry`), `:333-368` (`openclaw.plugin.json` example), `:506-535` (`defineChannelPluginEntry` example) all resolve |
| `@maxhub/max-bot-api` (external) — paths `src/bot.ts`, `src/core/network/polling.ts`, `src/core/network/api/client.ts`, `src/core/network/api/types/subcription.ts`, `src/core/network/api/modules/subscriptions/types.ts` | external SDK; not yet a dependency in `package.json`/`pnpm-lock.yaml` (verified by grep) | independent of openclaw upstream — these citations describe vendor SDK bug surface for §6.1.6. Sync requires checking npm separately when Phase 1A starts; not blocked by this analysis |

## §4 plan.md citation verification

Total unique citation lines/ranges in `plan.md`: **79** (`grep -nE
'\b[a-zA-Z0-9_/.-]+\.(ts\|js\|json\|tsx\|md):[0-9]+' ... | sort -u
| wc -l`).

Bucketed status:

- **Exact matches (line/range matches the cited construct):** 73
  - Notable exact: `src/channels/plugins/types.adapters.ts:341` →
    `ChannelGatewayAdapter`; `:545` → `ChannelLifecycleAdapter`;
    `src/plugin-sdk/extension-shared.ts:69` →
    `runStoppablePassiveMonitor`; `extensions/nextcloud-talk/src/types.ts:151-161`
    → `NextcloudTalkInboundMessage`; `extensions/telegram/src/channel.ts:741`
    → `onAccountConfigChanged`; `extensions/telegram/src/accounts.ts:117`
    → `apiRoot: accountCfg?.apiRoot`.
- **Approximate (broad range covers the cited concept ±a few lines):** 5
  - `extensions/nextcloud-talk/src/inbound.ts:175-196` cited for the
    pairing branch — `pairing.issueChallenge` actually starts at
    `:177`. Surrounding block fits in the cited range.
  - `extensions/telegram/src/polling-session.ts:120-352` cited as a
    supervisor-shape reference. The function body and surrounding
    abort-handling spans the range; no specific anchor needs to be
    pinned.
  - `extensions/telegram/src/bot-message-dispatch.ts:114-400` cited
    as an update-routing reference. Range covers the
    `DispatchTelegramMessageParams` type and routing logic; not a
    single pinned anchor.
  - `src/channels/plugins/types.adapters.ts:238-312` cited for
    `ChannelGatewayContext.abortSignal`. The type starts at `:238`
    and `abortSignal` is at `:243`; range over-covers slightly but
    points at the right type.
  - `extensions/nextcloud-talk/src/secret-contract.ts:11-55` cited
    for both `secretTargetRegistryEntries` and
    `collectRuntimeConfigAssignments`. Both constructs sit in the
    range; entries actually start at `:10`, off-by-one cosmetic.
- **Needs update (line drift, same-meaning):** 1
  - `extensions/nextcloud-talk/src/config-schema.ts:8` for
    `requireChannelOpenAllowFrom` from `extension-shared` —
    actual import is on `:9`. Plan §3.1 row `requireChannelOpenAllowFrom,
    runStoppablePassiveMonitor | extension-shared` should change
    `config-schema.ts:8` to `config-schema.ts:9`. The symbol and module
    are unchanged.
- **Breaking (function gone, signature changed, file moved):** 0

No citation in plan.md targets a construct that has been renamed,
moved, or had its signature changed by either the `2026.5.2` release or
the `Unreleased` post-`2026.5.2` work.

## §5 Architectural compatibility check

### §6.1.3 Lifecycle integration

- `ChannelGatewayAdapter` (`src/channels/plugins/types.adapters.ts:341`)
  unchanged. `startAccount` / `stopAccount` signatures still take
  `ChannelGatewayContext<ResolvedAccount>` and the context still
  carries `abortSignal`, `runtime`, `setStatus` — exactly what the
  plan's polling supervisor expects.
- `ChannelLifecycleAdapter` (`:545`) unchanged. `onAccountConfigChanged`
  still receives `{ prevCfg, nextCfg, accountId }`, which is the hook
  plan §6.1.3 uses for token-hash invalidation.
- `runStoppablePassiveMonitor` (`src/plugin-sdk/extension-shared.ts:69`)
  unchanged. Signature: `<TMonitor extends StoppableMonitor>({ abortSignal,
  start: () => Promise<TMonitor> }): Promise<void>`. The plan's
  supervisor wraps a polling loop in a `StoppableMonitor` (an object
  with `.stop()`) and hands it back from `start`; that contract is the
  same one Nextcloud Talk uses today (`extensions/nextcloud-talk/src/gateway.ts:30-43`).
- **Verdict:** compatible.

### §6.1.6 Custom Polling Supervisor

External-dependency stability matrix:

- **`api.getUpdates()` from `@maxhub/max-bot-api`** — external vendor SDK,
  not an openclaw concern. The plan §6.1.6 specifically calls out the
  reasons we bypass `bot.start()` (no `Retry-After` parsing, no
  exponential backoff, marker not persisted, abort signal not wired
  into `fetch`). None of those are functions of openclaw's release
  cadence. Phase 1A still needs to confirm npm publishes nothing newer
  than the analyzed version; that's a separate check at Phase 1A kick-off,
  not blocking now.
- **`ChannelPlugin` lifecycle hooks (`startAccount` / `stopAccount` /
  `onAccountConfigChanged`)** — verified unchanged in §3 and §5
  above. Stable.
- **Marker store** — plan §8 #17 designs a per-account marker store
  modeled after `extensions/telegram/src/update-offset-runtime.ts`
  loaded via `loadTelegramUpdateOffsetRuntime()` (referenced from
  `extensions/telegram/src/channel.ts:741`). That helper and its
  on-disk layout are unchanged on fork main. Stable.

**Verdict:** compatible. The plan's bypass-`bot.start()` design is grounded
in vendor SDK behavior; openclaw's `2026.5.2` line introduces no
incompatible lifecycle, hook, or marker-store changes.

### §6.1.7 Fake-MAX Test Harness

The harness sits inside the new plugin's tests; it depends only on
generic openclaw test scaffolding (`vitest`, plugin-loader test
helpers) and on `@maxhub/max-bot-api` mock surfaces. None of the
referenced openclaw test infrastructure changed in the diff scope.

**Verdict:** unaffected.

### §5 channels.max-messenger schema

Plan's `channels.max-messenger` Zod schema reuses `DmPolicySchema`,
`GroupPolicySchema`, `MarkdownConfigSchema`, `ReplyRuntimeConfigSchemaShape`,
`ToolPolicySchema`, `requireOpenAllowFrom` from
`openclaw/plugin-sdk/channel-config-schema`, plus
`requireChannelOpenAllowFrom` from `openclaw/plugin-sdk/extension-shared`.
All seven exports are still present at the cited barrels. The
post-`2026.5.2` `Channels/secrets: resolve SecretRef-backed channel
credentials through external plugin secret contracts` change is
*about* the secret-contract path, not the config-schema path, and the
plan's secret-contract design (mirroring Nextcloud Talk) already uses
external secret contracts.

**Verdict:** compatible.

## §6 Recommendation

**(А) Merge PR #2 as-is, sync as separate PR.**

Justifying facts:

1. The plan was authored against fork main `39bc94e4`, which is itself
   one in-development cycle ahead of the released `2026.5.2`. The plan
   already incorporates `2026.5.2` (§3 confirms zero file drift on the
   cited surfaces).
2. 78 of 79 file:line citations match exactly or with broad-range
   acceptable variance; the single off-by-one
   (`config-schema.ts:8` → `:9` for `requireChannelOpenAllowFrom`)
   is cosmetic and does not change the symbol, module, or design.
3. No upstream change in either the `2026.5.2` released line or the
   `Unreleased` delta touches `ChannelGatewayAdapter`,
   `ChannelLifecycleAdapter`, `ChannelGatewayContext`,
   `runStoppablePassiveMonitor`, or any of the channel-config-schema
   barrels the plan depends on (§5).
4. The plan's external-dependency surface (`@maxhub/max-bot-api`) is
   independent of openclaw release cadence; Phase 1A npm check is the
   right place to re-verify that, not this analysis.
5. The "sync" itself is essentially a no-op for this fork: fork main
   *is* the place where post-`2026.5.2` work is accumulating. There is
   no separate `openclaw/openclaw` upstream remote to merge from in
   this checkout, and no Unreleased changelog entry that would force a
   plan revision before merging PR #2.

The single off-by-one citation is small enough to fold into the next
plan-edit pass (Phase 1A kickoff or N8 follow-up); it does not warrant
holding PR #2.

## §7 Action items

Recommendation (А) is "merge as-is, follow up later," so the action
list is short and non-blocking.

1. **Merge PR #2 once owner sign-off arrives.** No code review changes
   required from this analysis. The plan is internally consistent
   against fork main `39bc94e4`.
2. **At Phase 1A kickoff** (separate PR), fold the cosmetic
   `config-schema.ts:8` → `:9` correction into the plan §3.1 SDK
   adapter table when that section is being edited anyway. No urgency.
3. **At Phase 1A kickoff**, run `npm view @maxhub/max-bot-api versions`
   to confirm the vendor SDK behavior described in plan §6.1.6 still
   reflects the latest published version. If a newer SDK ships before
   Phase 1A starts, re-read `src/core/network/polling.ts` and the
   client/marker types to see whether the bypass design is still
   needed (current state: it is, per plan §6.1.6).
4. **Optional / later.** If/when the project switches to tracking a
   separate `openclaw/openclaw` upstream remote, configure
   `git remote add upstream` and run a real
   `git diff <upstream/v2026.5.2>..origin/main -- <cited paths>` for
   audit. Not needed for the PR #2 decision.

https://github.com/mefodiytr/openclaw/pull/2
