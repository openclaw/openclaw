# Changelog

## 0.12.0 - 2026-03-09

### Highlights

- Admin: full Workspace Admin users/groups coverage for common directory operations. (#403) — thanks @dl-alexandre.
- Auth: new headless/cloud auth paths with ADC, direct access tokens, custom callbacks, proxy-safe loopback settings, and extra-scope controls. (#357, #419, #227, #398, #421) — thanks @tengis617, @mmkal, @cyberfox, @salmonumbrella, and @peteradams2026.
- Docs: much stronger document editing and export flow with tab targeting, richer find-replace, pageless mode, and native Markdown/HTML export. (#330, #305, #300, #282, #141) — thanks @ignacioreyna, @chparsons, @shohei-majima, @fprochazka, and @in-liberty420.
- Sheets: spreadsheet editing/formatting expands significantly with named ranges, tab management, notes, find-replace, formatting controls, inserts, links, and format inspection. (#278, #309, #430, #341, #320, #203, #374, #284) — thanks @TheCrazyLex, @JulienMalige, @andybergon, @Shehryar, @omothm, and @nilzzzzzz.
- Calendar: aliases, subscribe, and selector parity make multi-calendar workflows much easier. (#393, #327, #319) — thanks @salmonumbrella and @cdthompson.
- Forms/Slides/Keep: forms management + watches, slides from templates, and first write/delete coverage for Keep. (#274, #273, #413) — thanks @alexknowshtml, @penguinco, and @jgwesterlund.

### Added

- Admin: add Workspace Admin Directory commands for users and groups, including user list/get/create/suspend and group membership list/add/remove. (#403) — thanks @dl-alexandre.
- Auth: add Application Default Credentials mode via `GOG_AUTH_MODE=adc` for Workload Identity, Cloud Run, and local `gcloud` ADC flows without stored OAuth refresh tokens. (#357) — thanks @tengis617.
- Auth: add `--access-token` / `GOG_ACCESS_TOKEN` for direct access-token auth in headless or CI flows, bypassing stored refresh tokens. (#419) — thanks @mmkal.
- Auth: add `auth add|manage --listen-addr` plus `--redirect-host` for browser OAuth behind proxies or remote loopback forwarding. (#227) — thanks @cyberfox.
- Auth: add `auth add --redirect-uri` for manual/remote OAuth flows, so custom callback hosts can be reused across the printed auth URL, state cache, and code exchange. (#398) — thanks @salmonumbrella.
- Auth: add `--extra-scopes` to `auth add` for appending custom OAuth scope URIs beyond the built-in service scopes. (#421) — thanks @peteradams2026.
- Docs: add `--tab-id` to editing commands so write/update/insert/delete/find-replace can target a specific Google Docs tab. (#330) — thanks @ignacioreyna.
- Docs: extend `docs find-replace` with `--first`, `--content-file`, Markdown replacement, inline image insertion, and image sizing syntax. (#305) — thanks @chparsons.
- Docs: add `--pageless` to `docs create`, `docs write`, and `docs update` to switch documents into pageless mode after writes. (#300) — thanks @shohei-majima.
- Docs: add native Google Docs Markdown export via `docs export --format md`. (#282) — thanks @fprochazka.
- Docs: add native Google Docs HTML export via `docs export --format html`. (#141) — thanks @in-liberty420.
- Sheets: add named range management (`sheets named-ranges`) and let range-based Sheets commands accept named range names where GridRange-backed operations are needed. (#278) — thanks @TheCrazyLex.
- Sheets: add `add-tab`, `rename-tab`, and `delete-tab` commands for managing spreadsheet tabs, with delete dry-run/confirmation guardrails. (#309) — thanks @JulienMalige.
- Sheets: add `merge`, `unmerge`, `number-format`, `freeze`, `resize-columns`, and `resize-rows` commands for spreadsheet layout/format control. (#320) — thanks @Shehryar.
- Sheets: add `sheets update-note` / `set-note` to write or clear cell notes across a range. (#430) — thanks @andybergon.
- Sheets: add `sheets find-replace` to replace text across a spreadsheet or a specific tab, with exact-match, regex, and formula search options. (#341) — thanks @Shehryar.
- Sheets: add `sheets insert` to insert rows/columns into a sheet. (#203) — thanks @andybergon.
- Sheets: add `sheets create --parent` to place new spreadsheets in a Drive folder. (#424) — thanks @ManManavadaria.
- Sheets: add `sheets read-format` to inspect `userEnteredFormat` / `effectiveFormat` per cell. (#284) — thanks @nilzzzzzz.
- Sheets: add `sheets links` (alias `hyperlinks`) to list cell links from ranges, including rich-text links. (#374) — thanks @omothm.
- Forms: add form update/question-management commands plus response watch create/list/delete/renew, with delete-question validation and confirmation guardrails. (#274) — thanks @alexknowshtml.
- Slides: add `create-from-template` with `--replace` / `--replacements`, dry-run support, and template placeholder replacement stats. (#273) — thanks @penguinco.
- Calendar: add `calendar alias list|set|unset`, and let calendar commands resolve configured aliases before API/name lookup. (#393) — thanks @salmonumbrella.
- Calendar: let `calendar freebusy` / `calendar conflicts` accept `--cal`, names, indices, and `--all` like `calendar events`. (#319) — thanks @salmonumbrella.
- Calendar: add `calendar subscribe` (aliases `sub`, `add-calendar`) to add a shared calendar to the current account’s calendar list. (#327) — thanks @cdthompson.
- Gmail: add `watch serve --history-types` filtering (`messageAdded|messageDeleted|labelAdded|labelRemoved`) and include `deletedMessageIds` in webhook payloads. (#168) — thanks @salmonumbrella.
- Gmail: add `gmail labels rename` to rename user labels by ID or exact name, with system-label guards and wrong-case ID safety. (#391) — thanks @adam-zethraeus.
- Gmail: add `gmail messages modify` for single-message label changes, complementing thread- and batch-level modify flows. (#281) — thanks @zerone0x.
- Gmail: add `gmail filters export` to dump filter definitions as JSON to stdout or a file for backup/script workflows. (#119) — thanks @Jeswang.
- Keep: add `keep create` for text/checklist notes and `keep delete` for note removal. (#413) — thanks @jgwesterlund.
- Contacts: support `--org`, `--title`, `--url`, `--note`, and `--custom` on create/update; include custom fields in get output with deterministic ordering. (#199) — thanks @phuctm97.
- Contacts: add `--relation type=person` to contact create/update, include relations in text `contacts get`, and cover relation payload updates. (#351) — thanks @karbassi.
- Contacts: add `--address` to contact create/update and include addresses in text `contacts get`. (#148) — thanks @beezly.
- Drive: add `drive ls --all` (alias `--global`) to list across all accessible files; make `--all` and `--parent` mutually exclusive. (#107) — thanks @struong.
- Chat: add `chat messages reactions create|list|delete` to manage emoji reactions on messages; `chat messages react <message> <emoji>` as a shorthand for creating reactions; `reaction` is an alias for `reactions`. (#426) — thanks @fernandopps.
- Tasks: add `--recur` / `--recur-rrule` aliases for repeat materialization, including RRULE `INTERVAL` support for generated occurrences. (#408) — thanks @salmonumbrella.

### Fixed

- Google API: use transport-level response-header timeouts for API clients while keeping token exchanges bounded, so large downloads are not cut short by `http.Client.Timeout`. (#425) — thanks @laihenyi.
- Timezone: embed the IANA timezone database so Windows builds can resolve calendar timezones correctly. (#388) — thanks @visionik.
- Auth: persist rotated OAuth refresh tokens returned during API calls so later commands keep working without re-auth. (#373) — thanks @joshp123.
- Auth: allow pure service-account mode when the configured subject matches the service account itself, instead of forcing domain-wide delegation impersonation. (#399) — thanks @carrotRakko.
- Auth: keep Keep-only service-account fallback isolated to Keep commands so other Google services do not accidentally pick it up. (#414) — thanks @jgwesterlund.
- Auth: add `--gmail-scope full|readonly`, and disable `include_granted_scopes` for readonly/limited auth requests to avoid Drive/Gmail scope accumulation. (#113) — thanks @salmonumbrella.
- Auth: preserve scope-shaping flags in the remote step-2 replay guidance for `auth add --remote`. (#427) — thanks @doodaaatimmy-creator.
- Calendar: preserve full RRULE values and recurring-event timezones during updates so recurrence edits don’t lose BYDAY lists or hit missing-timezone API errors. (#392) — thanks @salmonumbrella.
- Calendar: let recurring `calendar update --scope=future` and `calendar delete --scope=future` start from an instance event ID by resolving the parent series first. (#319) — thanks @salmonumbrella.
- Calendar: use `Calendars.Get` for timezone lookups so service-account flows don’t 404 on `calendarList/primary`. (#325) — thanks @markwatson.
- Calendar: hide cancelled/deleted events from `calendar events` list output by explicitly setting `showDeleted=false`. (#362) — thanks @sharukh010.
- Calendar: reject ambiguous calendar-name selectors for `calendar events` instead of guessing. (#131) — thanks @salmonumbrella.
- Calendar: respond patches only attendees to avoid custom reminders validation errors. (#265) — thanks @sebasrodriguez.
- Calendar: force-send `minutes=0` for `--reminder popup:0m` so zero-minute popup reminders survive Google Calendar API JSON omission rules. (#316) — thanks @salmonumbrella.
- Calendar: clarify that RFC3339 `--from/--to` timestamps must include a timezone while keeping date and relative-time help intact. (#409) — thanks @dbhurley.
- Gmail: add a fetch delay in `watch serve` so History API reads don't race message indexing. (#397) — thanks @salmonumbrella.
- Gmail: preserve the selected `--client` during `watch serve` push handling instead of falling back to the default client. (#411) — thanks @chrysb.
- Gmail: allow Workspace-managed send-as aliases with empty verification status in `send` and `drafts create`. (#407) — thanks @salmonumbrella.
- Gmail: fall back to `MimeType` charset hints when `Content-Type` headers are missing so GBK/GB2312 message bodies decode correctly. (#428) — thanks @WinnCook.
- Gmail: `drafts update --quote` now picks a non-draft, non-self message from thread fallback (or errors clearly), avoiding self-quote loops and wrong reply headers. (#394) — thanks @salmonumbrella.
- Gmail: preserve `Cc` metadata output in plain `gmail get --format metadata` even when Gmail returns uppercase `CC` headers. (#343) — thanks @salmonumbrella.
- Gmail: `gmail archive|read|unread|trash` convenience commands now honor `--dry-run` and emit action-specific dry-run ops. (#385) — thanks @yeager.
- Sheets: harden `sheets format` against `boarders` typo (JSON and field mask), with clearer error messages. (#284) — thanks @nilzzzzzz.
- Sheets: force-send empty note values so `sheets update-note --note ''` reliably clears notes via the API. (#341) — thanks @Shehryar.
- Contacts: send the required `copyMask` when deleting "other contacts", avoiding People API 400 errors. (#384) — thanks @rbansal42.
- Groups: include required label filters in transitive group searches so `groups list` doesn’t 400 on Cloud Identity. (#315) — thanks @salmonumbrella.
- Sheets: make `sheets metadata --plain` emit real TSV tab delimiters, with regression coverage for plain tabular sheet output. (#298) — thanks @mahsumaktas.
- CLI: show root help instead of a parse error when `gog` is run with no arguments. (#342) — thanks @cstenglein.
- CLI: include the current partial token in fish shell completion so `gog __complete` sees the active word under the cursor. (#123) — thanks @GiGurra.

### Security & Reliability

- Secrets: verify keyring token writes by reading them back, so macOS headless Keychain failures return an actionable error instead of silently storing 0 bytes. (#270) — thanks @zerone0x.
- Secrets: respect empty `GOG_KEYRING_PASSWORD` (treat set-to-empty as intentional; avoids headless prompts). (#269) — thanks @zerone0x.
- Security: require confirmation before public Drive shares, Gmail forwarding filters, and Gmail delegate grants in no-input/agent flows. (#317) — thanks @salmonumbrella.
- Security: redact stored Gmail watch webhook bearer tokens in `gmail watch status` text and JSON output unless `--show-secrets` is set. (#136) — thanks @paveg.

### Tooling & Docs

- Docs: update install docs to use the official Homebrew core formula (`brew install gogcli`). (#361) — thanks @zeldrisho.
- Contacts: fix grouped parameter types in CRUD helpers to restore builds on newer Go toolchains. (#355) — thanks @laihenyi.
- CI: validate release tags and quote the checkout ref in the release workflow to block tag-script injection on manual releases. (#299) — thanks @salmonumbrella.
- Build: refresh the dependency stack to Go 1.26.1, current Go indirects, GitHub Actions v6/v7 pins, and current Cloudflare worker dependencies.
- Keep: request the writable Keep service-account scope now that note create/delete is supported. (#413) — thanks @jgwesterlund.

## 0.11.0 - 2026-02-15

### Added

- Apps Script: add `appscript` command group (create/get projects, fetch content, run deployed functions).
- Forms: add `forms` command group (create/get forms, list/get responses).
- Docs: add `docs comments` for listing and managing Google Doc comments. (#263) — thanks @alextnetto.
- Sheets: add `sheets notes` to read cell notes. (#208) — thanks @andybergon.
- Gmail: add `gmail send --quote` to include quoted original message in replies. (#169) — thanks @terry-li-hm.
- Drive: add `drive ls|search --no-all-drives` to restrict queries to "My Drive" for faster/narrower results. (#258)
- Contacts: update contacts from JSON via `contacts update --from-file` (PR #200 — thanks @jrossi).

### Fixed

- Drive: make `drive delete` move files to trash by default; add `--permanent` for irreversible deletion. (#262) — thanks @laihenyi.
- Drive/Gmail: pass through Drive API filter queries in `drive search`; RFC 2047-encode non-ASCII display names in mail headers (`From`/`To`/`Cc`/`Bcc`/`Reply-To`). (#260) — thanks @salmonumbrella.
- Calendar: allow opting into attendee notifications for updates and cancellations via `calendar update|delete --send-updates all|externalOnly|none`. (#163) — thanks @tonimelisma.
- Calendar: fall back to fixed-offset timezones (`Etc/GMT±N`) for recurring events when given RFC3339 offset datetimes; harden Gmail attachment output paths and cache validation; honor proxy defaults for Google API transports. (#228) — thanks @salmonumbrella.
- Auth: manual OAuth flow uses an ephemeral loopback redirect port (avoids unsafe/privileged ports in browsers). (#172) — thanks @spookyuser.
- Gmail: include primary display name in `gmail send` From header when using service account impersonation (domain-wide delegation). (#184) — thanks @salmonumbrella.
- Gmail: when `gmail attachment --out` points to a directory (or ends with a trailing slash), combine with `--name` and avoid false cache hits on directories. (#248) — thanks @zerone0x.
- Drive: include shared drives in `drive ls` and `drive search`; reject `drive download --format` for non-Google Workspace files. (#256) — thanks @salmonumbrella.
- Drive: validate `drive download --format` values and error early for unknown formats. (#259)

## 0.10.0 - 2026-02-14

### Added

- Docs/Slides: add `docs update` markdown formatting + table insertion, plus markdown-driven slides creation and template-based slide creation. (#219) — thanks @maxceem.
- Slides: add add-slide/list-slides/delete-slide/read-slide/update-notes/replace-slide for image decks, including --before insertion and --notes '' clear behavior. (#214) — thanks @chrismdp.
- Docs: add tab support (`docs list-tabs`, `docs cat --tab`, `docs cat --all-tabs`) and editing commands (`docs write|insert|delete|find-replace`). (#225) — thanks @alexknowshtml.
- Docs: add `docs create --file` to import Markdown into Google Docs with inline image support and hardened temp-file cleanup. (#244) — thanks @maxceem.
- Drive: add `drive upload --replace` to update files in-place (preserves `fileId`/shared link). (#232) — thanks @salmonumbrella.
- Drive: add upload conversion flags `--convert` (auto) and `--convert-to` (`doc|sheet|slides`). (#240) — thanks @Danielkweber.
- Drive: share files with an entire Workspace domain via `drive share --to domain`. (#192) — thanks @Danielkweber.
- Gmail: add `--exclude-labels` to `watch serve` (defaults: `SPAM,TRASH`). (#194) — thanks @salmonumbrella.
- Gmail: add `gmail labels delete <labelIdOrName>` with confirm + system-label guardrails and case-sensitive ID handling. (#231) — thanks @Helmi.
- Contacts: support `contacts update --birthday` and `--notes`; unify shared date parsing and docs. (#233) — thanks @rosssivertsen.

### Fixed

- Live tests: make `scripts/live-test.sh` and `scripts/live-chat-test.sh` CWD-safe (repo-root aware builds and sourcing).
- Calendar: interpret date-only and relative day `--to` values as inclusive end-of-day while keeping `--to now` as a point-in-time bound. (#204) — thanks @mjaskolski.
- Auth: improve remote/server-friendly manual OAuth flow (`auth add --remote`). (#187) — thanks @salmonumbrella.
- Gmail: avoid false quoted-printable detection for already-decoded URLs with uppercase hex-like tokens while still decoding unambiguous markers (`=3D`, chained escapes, soft breaks). (#186) — thanks @100menotu001.
- Sheets: preserve TSV tab delimiters for `sheets get --plain` output. (#212) — thanks @salmonumbrella.
- CLI: land PR #201 with conflict-resolution fixes for `--fields` rewrite, calendar `--all` paging, schema command-path parsing, and case-sensitive Gmail watch exclude-label IDs. (#201) — thanks @salmonumbrella.
- Secrets: set keyring item labels to `gogcli` so macOS security prompts show a clear item name. (#106) — thanks @maxceem.

## 0.9.0 - 2026-01-22

### Highlights

- Auth: multi-org login with per-client OAuth credentials + token isolation. (#96)

### Added

- Calendar: show event timezone and local times; add --weekday output. (#92) — thanks @salmonumbrella.
- Gmail: show thread message count in search output. (#99) — thanks @jeanregisser.
- Gmail: message-level search with optional body decoding. (#88) — thanks @mbelinky.

### Fixed

- Auth: fix Gmail search example in auth success template. (#89) — thanks @rvben.
- CLI: remove redundant newlines in text output for calendar, chat, Gmail, and groups commands. (#91) — thanks @salmonumbrella.
- Gmail: include primary account display name in send From header when available. (#93) — thanks @salmonumbrella.
- Keyring: persist OAuth tokens across Homebrew upgrades. (#94) — thanks @salmonumbrella.
- Docs: update Gmail command examples in README. (#95) — thanks @chrisrodz.
- Contacts: include birthdays in contact get output. (#102) — thanks @salmonumbrella.
- Calendar: force custom reminders payload to send UseDefault=false. (#100) — thanks @salmonumbrella.
- Gmail: add read alias + default thread get. (#103) — thanks @salmonumbrella.

## 0.8.0 - 2026-01-19

### Added

- Chat: spaces, messages, threads, and DM commands (Workspace only). (#84) — thanks @salmonumbrella.
- People: profile lookup, directory search, and relations commands. (#84) — thanks @salmonumbrella.

### Fixed

- Chat: normalize thread IDs and show a clearer error for consumer accounts. (#84)

## 0.7.0 - 2026-01-17

### Highlights

- Classroom: full command suite (courses, roster, coursework/materials, announcements, topics, invitations, guardians, profiles) plus course URLs. (#73) — thanks @salmonumbrella.
- Calendar: propose-time command and enterprise event types (Focus Time/Out of Office/Working Location). (#75) — thanks @salmonumbrella.
- Gmail: attachment details in `gmail get` (humanized sizes + JSON fields). (#83) — thanks @jeanregisser.

### Added

- Auth: permission upgrade UI in the account manager + missing service icons. (#73) — thanks @salmonumbrella.
- CLI: auth aliases, `time now`, `--enable-commands` allowlist, and day-of-week JSON fields. (#75) — thanks @salmonumbrella.
- Tasks: repeat schedules + `tasks get` command. (#75) — thanks @salmonumbrella.

### Fixed

- Calendar: propose-time decline sends updates, default events to primary, and improved error guidance. (#75)
- Gmail: resync on stale history 404s and skip missing message fetches without masking non-404 failures. (#70) — thanks @antons.
- Gmail: include `gmail.settings.sharing` scope for filter operations to avoid 403 insufficientPermissions. (#69) — thanks @ryanh-ai.
- Auth: request Gmail settings scopes so settings commands work reliably.
- Auth: account manager upgrade respects managed services and skips Keep OAuth scopes. (#73) — thanks @salmonumbrella.
- Classroom: normalize assignee updates + fix grade update masks; scan pages when filtering coursework/materials by topic; add leave confirmation. (#73, #74) — thanks @salmonumbrella.
- Tasks: normalize due dates to RFC3339 so date-only inputs work reliably (including repeat).
- Timezone: honor `--timezone local` and allow env/config defaults for Gmail + Calendar output. (#79) — thanks @salmonumbrella.
- CLI: enable shell completions and stop flag suggestions after `--`. (#77) — thanks @salmonumbrella.
- Groups: friendlier Cloud Identity errors for consumer accounts and missing scopes.

### Build

- Deps: update Go modules and JS worker dev deps; bump pinned dev tools; switch WSL to v5.

### Tests

- Live: add `scripts/live-test.sh` wrapper and expand smoke coverage across services.
- Calendar: add integration tests for propose-time.
- Gmail: add attachment output tests for `gmail get`.
- Classroom: add integration smoke tests and command coverage.
- Drive: expand `drive drives` coverage (formatting + query/paging params).
- Auth: use `net.ListenConfig.Listen` in tests to satisfy newer lint.

## 0.6.1 - 2026-01-15

### Added

- Gmail: `--body-file` for `send`, `drafts create`, and `drafts update` (use `-` for stdin) to send multi-line plain text.
- Drive: `gog drive drives` lists shared drives (Team Drives). (#67) — thanks @pasogott.
- Sheets: `gog sheets format` applies cell formatting via `--format-json` + `--format-fields`. (#72) — thanks @nilzzzzzz.

### Changed

- Tasks: `gog tasks list` now defaults to `--show-assigned`. (#59) — thanks @tompson.

## 0.6.0 - 2026-01-11

### Added

- Auth: Workspace service accounts (domain-wide delegation) for all services via `gog auth service-account ...` (preferred when configured). (#54) — thanks @pvieito.

### Fixed

- Keep: use `keep.readonly` scope (service account). (#64) — thanks @jeremys.
- Sheets: `gog auth add --services sheets --readonly` now includes Drive read-only scope so `gog sheets export` works. (#62)

### Tests

- Auth: expand scope matrix regression tests for `--readonly` and `--drive-scope`. (#63)

## 0.5.4 - 2026-01-10

### Changed

- Gmail: allow drafts without a recipient; drafts update preserves existing `To` when `--to` is omitted. (#57) — thanks @antons.

### Added

- Auth: `gog auth add --readonly` and `--drive-scope` for least-privilege tokens. (#58) — thanks @jeremys.

### Fixed

- Paths: expand leading `~` in user-provided file paths (e.g. `--out "~/Downloads/file.pdf"`). (#56) — thanks @salmonumbrella.
- Calendar: accept ISO 8601 timezones without colon (e.g. `-0800`) and add `gog calendar list` alias. (#56) — thanks @salmonumbrella.

## 0.5.3 - 2026-01-10

### Fixed

- CLI: infer account when `--account`/`GOG_ACCOUNT` not set (uses keyring default or single stored token).

## 0.5.2 - 2026-01-10

### Fixed

- Release builds: embed version/commit/date so `gog --version` is correct (Homebrew/tap installs too).

## 0.5.1 - 2026-01-09

### Added

- Build: Windows arm64 release binary.

## 0.5.0 - 2026-01-09

### Highlights

- Email open tracking: `gog gmail send --track` + `gog gmail track ...` (Cloudflare Worker backend; optional per-account setup + `--track-split`) (#35) — thanks @salmonumbrella.
- Calendar parity + Workspace: recurrence rules/reminders, Focus Time/OOO/Working Location event types, workspace users list, and Groups/team helpers (#41) — thanks @salmonumbrella.
- Auth + config: JSON5 `config.json`, improved `gog auth status`, `gog auth keyring ...`, and refresh token validation via `gog auth list --check`.
- Secrets UX: safer keyring behavior (headless Linux guard; keychain unlock guidance).
- Keep: Workspace-only Google Keep support — thanks @koala73.

### Features

- Calendar:
  - `gog calendar create|update --rrule/--reminder` for recurrence rules and custom reminders — thanks @salmonumbrella.
  - `gog calendar update --add-attendee ...` to add attendees without losing existing RSVP state.
  - Workspace users list + timezone-aware time windows and flags like `--week-start`.
- Gmail:
  - `gog gmail thread attachments` list/download attachments (#27) — thanks @salmonumbrella.
  - `gog gmail thread get --full` shows complete bodies (default truncates) (#25) — thanks @salmonumbrella.
  - `gog gmail labels create`, reply-all support, thread search date display, and thread-id replies.
  - `gog gmail get --json` includes flattened headers, `unsubscribe`, and extracted `body` (for `--format full`).
  - `gog gmail settings ...` reorg + filter operations now request the right settings scope (thanks @camerondare).
- Keep: list/search/get notes and download attachments (Workspace only; service account via `gog auth keep ...`) — thanks @koala73.
- Contacts: `gog contacts other delete` for removing other contacts (thanks @salmonumbrella).
- Drive: comments subcommand.
- Sheets: `sheets update|append --copy-validation-from ...` copies data validation (#29) — thanks @mahmoudashraf93.
- Auth/services:
  - `docs` service support + service metadata/listing (thanks @mbelinky).
  - `groups` service support for Cloud Identity (Workspace only): `gog auth add <email> --services groups`.
  - `gog auth keyring <auto|keychain|file>` writes `keyring_backend` to `config.json`.
  - `GOG_KEYRING_BACKEND={auto|keychain|file}` to force a backend (use `file` to avoid Keychain prompts; pair with `GOG_KEYRING_PASSWORD`).
- Docs: `docs info`/`docs cat` now use the Docs API (Drive still used for exports/copy/create).
- Build: linux_arm64 release target.

### Fixed

- Calendar: recurring event creation now sets an IANA `timeZone` inferred from `--from/--to` offsets (#53) — thanks @visionik.
- Secrets:
  - Headless Linux no longer hangs on D-Bus; auto-fallback to file backend and timeout guidance for edge cases (fixes #45) — thanks @salmonumbrella.
  - Keyring backend normalization/validation and clearer errors — thanks @salmonumbrella.
  - macOS Keychain: detect “locked” state and offer unlock guidance.
- Auth: OAuth browser flow now finishes immediately after callback; manual OAuth paste accepts EOF; verify requested account matches authorized email; store tokens under the real account email (Google userinfo).
- Auth: `gog auth tokens list` filters non-token keyring entries.
- Gmail: watch push dedupe/historyId sync improvements; List-Unsubscribe extraction; MIME normalization + padded base64url support (#52) — thanks @antons.
- Gmail: drafts update preserves thread/reply headers when updating existing drafts (#55) — thanks @antons.

### Changed

- CLI: help output polish (grouped by default, optional full expansion via `GOG_HELP=full`); colored headings/command names; more flag aliases like `--output`/`--output-dir` (#47) — thanks @salmonumbrella.
- Homebrew/DX: tap installs GitHub release binaries (macOS) to reduce Keychain prompt churn; remove pnpm wrapper in favor of `make gog` targets; `make gog <args>` works without `ARGS=`.
- Auth: `gog auth add` now defaults to `--services user` (`--services all` remains accepted for backwards compatibility).

## 0.4.2 - 2025-12-31

- Gmail: `thread modify` subcommand + `thread get` split (#21) — thanks @alexknowshtml.
- Auth: refreshed account manager + success UI (#20) — thanks @salmonumbrella.
- CLI: migrate from Cobra to Kong (same commands/flags; help/validation wording may differ slightly).
- DX: tighten golangci-lint rules and fix new findings.
- Security: config/attachment/export dirs now created with 0700 permissions.

## 0.4.1 - 2025-12-28

- macOS: release binaries now built with cgo so Keychain backend works (no encrypted file-store fallback / password prompts; Issue #19).

## 0.4.0 - 2025-12-26

### Added

- Resilience: automatic retries + circuit breaker for Google API calls (429/5xx).
- Gmail: batch ops + settings commands (autoforward, delegates, filters, forwarding, send-as, vacation).
- Gmail: `gog gmail thread --download --out-dir ...` for saving thread attachments to a specific directory.
- Calendar: colors, conflicts, search, multi-timezone time.
- Sheets: read/write/update/append/clear + create spreadsheets.
- Sheets: copy spreadsheets via Drive (`gog sheets copy ...`).
- Drive: `gog drive download --format ...` for Google Docs exports (e.g. Sheets to PDF/XLSX, Docs to PDF/DOCX/TXT, Slides to PDF/PPTX).
- Drive: copy files (`gog drive copy ...`).
- Docs/Slides/Sheets: dedicated export commands (`gog docs export`, `gog slides export`, `gog sheets export`).
- Docs: create/copy (`gog docs create`, `gog docs copy`) and print plain text (`gog docs cat`).
- Slides: create/copy (`gog slides create`, `gog slides copy`).
- Auth: browser-based accounts manager (`gog auth manage`).
- DX: shell completion (`gog completion ...`) and `--verbose` logging.

### Fixed

- Gmail: `gog gmail attachment` download now works reliably; avoid re-fetching payload for filename inference and accept padded base64 responses.
- Gmail: `gog gmail thread --download` now saves attachments to the current directory by default and creates missing output directories.
- Sheets: avoid flag collision with global `--json`; values input flag is now `--values-json` for `sheets update|append`.

### Changed

- Internal: reduce duplicate code for Drive-backed exports and tabular/paging output; embed auth UI templates as HTML assets.

## 0.3.0 - 2025-12-26

### Added

- Calendar: `gog calendar calendars` and `gog calendar acl` now support `--max` and `--page` (JSON includes `nextPageToken`).
- Drive: `gog drive permissions` now supports `--max` and `--page` (JSON includes `nextPageToken`).

### Changed

- macOS: stop trying to modify Keychain ACLs (“trust gog”); removed `GOG_KEYCHAIN_TRUST_APPLICATION`.
- BREAKING: remove positional/legacy flags; normalize paging and file output flags.
- BREAKING: replace `--output` with `--json` and `--plain` (and env `GOG_OUTPUT` with `GOG_JSON`/`GOG_PLAIN`).
- BREAKING: destructive commands now require `--force` in non-interactive contexts (or they prompt on TTY).
- BREAKING: `gog calendar create|update` uses `--from/--to` (removed `--start/--end`).
- BREAKING: `gog gmail send|drafts create` uses `--reply-to-message-id` (removed `--reply-to` for message IDs) and `--reply-to` (removed `--reply-to-address`).
- BREAKING: `gog gmail attachment` uses `--name` (removed `--filename`).
- BREAKING: Drive: `drive ls` uses `--parent` (removed positional `folderId`), `drive upload` uses `--parent` (removed `--folder`), `drive move` uses `--parent` (removed positional `newParentId`).
- BREAKING: `gog drive download` uses `--out` (removed positional `destPath`).
- BREAKING: `gog auth tokens export` uses `--out` (removed positional `outPath`).
- BREAKING: `gog auth tokens export` uses `--overwrite` (removed `--force`).

## 0.2.1 - 2025-12-26

### Fixed

- macOS: reduce repeated Keychain password prompts by trusting the `gog` binary by default (set `GOG_KEYCHAIN_TRUST_APPLICATION=0` to disable).

## 0.2.0 - 2025-12-24

### Added

- Gmail: watch + Pub/Sub push handler (`gog gmail watch start|status|renew|stop|serve`) with optional webhook forwarding, include-body, and max-bytes.
- Gmail: history listing via `gog gmail history --since <historyId>`.
- Gmail: HTML bodies for `gmail send` and `gmail drafts create` via `--body-html` (multipart/alternative when combined with `--body`, PR #16 — thanks @shanelindsay).
- Gmail: `--reply-to-address` (sets `Reply-To` header, PR #16 — thanks @shanelindsay).
- Tasks: manage tasklists and tasks (`lists`, `list`, `add`, `update`, `done`, `undo`, `delete`, `clear`, PR #10 — thanks @shanelindsay).

### Changed

- Build: `make` builds `./bin/gog` by default (adds `build` target, PR #12 — thanks @advait).
- Docs: local build instructions now use `make` (PR #12 — thanks @advait).

### Fixed

- Secrets: keyring file-backend fallback now stores encrypted entries in `$(os.UserConfigDir())/gogcli/keyring/` and supports non-interactive via `GOG_KEYRING_PASSWORD` (PR #13 — thanks @advait).
- Gmail: decode base64url attachment/message-part payloads (PR #15 — thanks @shanelindsay).
- Auth: add `people` service (OIDC `profile` scope) so `gog people me` works with `gog auth add --services all`.

## 0.1.1 - 2025-12-17

### Added

- Calendar: respond to invites via `gog calendar respond <calendarId> <eventId> --status accepted|declined|tentative` (optional `--send-updates`).
- People: `gog people me` (quick “me card” / `people/me`).
- Gmail: message get via `gog gmail get <messageId> [--format full|metadata|raw]`.
- Gmail: download a single attachment via `gog gmail attachment <messageId> <attachmentId> [--out PATH]`.

## 0.1.0 - 2025-12-12

Initial public release of `gog`: a single Go CLI that unifies Gmail, Calendar, Drive, and Contacts (People API).

### Added

- Unified CLI (`gog`) with service subcommands: `gmail`, `calendar`, `drive`, `contacts`, plus `auth`.
- OAuth setup and account management:
  - Store OAuth client credentials: `gog auth credentials <credentials.json>`.
  - Authorize accounts and store refresh tokens securely via OS keychain using `github.com/99designs/keyring`.
  - List/remove accounts: `gog auth list`, `gog auth remove <email>`.
  - Token management helpers: `gog auth tokens list|delete|export|import`.
- Consistently parseable output:
  - `--output=text` (tab-separated lists on stdout) and `--output=json` (JSON on stdout).
  - Human hints/progress/errors go to stderr.
- Colorized output in rich TTY (`--color=auto|always|never`), automatically disabled for JSON output.
- Gmail features:
  - Search threads, show thread, generate web URLs.
  - Label listing/get (including counts) and thread label modify.
  - Send mail (supports reply headers + attachments).
  - Drafts: list/get/create/send/delete.
- Calendar features:
  - List calendars, list ACL rules.
  - List/get/create/update/delete events and free/busy queries.
- Drive features:
  - List/search/get files, download (including Google Docs export), upload, mkdir, delete, move, rename.
  - Sharing helpers: share/unshare/permissions, and web URL output.
- Contacts / People API features:
  - Contacts list/search/get/create/update/delete.
  - “Other contacts” list/search.
  - Workspace directory list/search (Workspace accounts only).
- Developer experience:
  - Formatting via `gofumpt` + `goimports` (and `gofmt` implicitly) using `make fmt` / `make fmt-check`.
  - Linting via pinned `golangci-lint` with repo config.
  - Tests using stdlib `testing` + `httptest`, with steadily increased unit coverage.
  - GitHub Actions CI running format checks, tests, and lint.
  - `make` builds `./bin/gog` for local dev (`make && ./bin/gog auth add you@gmail.com`).

### Notes / Known Limitations

- Importing tokens into macOS Keychain may require a local (GUI) session; headless/SSH sessions can fail due to Keychain user-interaction restrictions.
- Workspace directory commands require a Google Workspace account; `@gmail.com` accounts will not work for directory endpoints.
