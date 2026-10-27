---
summary: "Credential eligibility and resolution rules for auth profiles"
title: "Auth credential semantics"
read_when:
  - Working on auth profile resolution or credential routing
  - Debugging model auth failures or profile order
---

These semantics keep selection-time and runtime auth behavior aligned. They are shared by:

- `resolveAuthProfileOrder` (profile ordering)
- `resolveApiKeyForProfile` (runtime credential resolution)
- `openclaw models status --probe`
- `openclaw doctor` auth checks (`doctor-auth`)

## Account status in Models

In **Settings → Models**, OAuth access-token expiry is separate from sign-in
health. **Access token expires in…** or **Access token expired** describes the
short-lived token, not necessarily the saved sign-in. The page does not infer
refresh support from OAuth alone. **Ready** requires a ready catalog result;
without that evidence, an account reporting only access-token expiry remains
**Credentials configured**.

A missing OAuth credential shows **Sign in again**. A refresh marker whose outcome
is not distinguished by the status response shows **Sign-in unavailable**, not a
claim that another login is required. A provider authentication rejection shows
**Credentials rejected** and takes precedence over expiry information. The card-wide
result does not identify the rejected credential, so it does not prescribe OAuth
sign-in or change recovery advice for an unrelated saved account. Static token
expiry keeps its warning. Externally managed credentials remain identified as
such, rather than being declared healthy just because another tool manages them.
Provider-reported quota exhaustion and temporary rate-limit errors remain usage
or connection results, not sign-out instructions.

<a id="stable-probe-reason-codes" />

## Stable check reason codes

Check results carry a `status` bucket (`ok`, `auth`, `rate_limit`, `billing`, `timeout`, `format`, `unknown`, `no_model`) plus a stable `reasonCode` when the check never reached a model call:

| `reasonCode`             | Meaning                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `excluded_by_auth_order` | Profile omitted from the explicit auth order for its provider.               |
| `missing_credential`     | No inline credential or SecretRef is configured.                             |
| `expired`                | Token `expires` is in the past.                                              |
| `invalid_expires`        | `expires` is not a valid positive Unix ms timestamp.                         |
| `unresolved_ref`         | Configured SecretRef could not be resolved.                                  |
| `ineligible_profile`     | Profile is incompatible with provider config (includes malformed key input). |
| `no_model`               | Credentials exist but no model candidate that can be tested resolved.        |

Eligibility checks report `ok` as the reason code for usable credentials.

## Token credentials

Token credentials (`type: "token"`) support inline `token` and/or `tokenRef`.

### Eligibility rules

1. A token profile is ineligible when both `token` and `tokenRef` are absent (`missing_credential`).
2. `expires` is optional. When present it must be a finite number of Unix epoch milliseconds greater than `0` and no larger than the maximum JavaScript `Date` timestamp (8640000000000000).
3. If `expires` is invalid (wrong type, `NaN`, `0`, negative, non-finite, or beyond that maximum), the profile is ineligible with `invalid_expires`.
4. If `expires` is in the past, the profile is ineligible with `expired`.
5. `tokenRef` does not bypass `expires` validation.

### Resolution rules

1. Resolver semantics match eligibility semantics for `expires`.
2. For eligible profiles, token material may be resolved from the inline value or `tokenRef`.
3. Unresolvable refs produce `unresolved_ref` in `models status --probe` output.

## Manual API keys

Saving a manual API key in Models waits for the Gateway to apply any changed
provider binding before refreshing model authentication. Replacing a key whose
binding is unchanged needs only the authentication refresh. If the Gateway cannot
confirm application, the key remains saved and the response includes a restart
warning. This preserves the configured reload policy, including disabled reloads.
Removing a key still rejects a binding or credential that changed concurrently.

Provider `apiKey` values that name an existing compatible API-key or token profile
are profile bindings, not literal credentials. Model discovery resolves those
bindings through the same profile classification used by chat requests, including
provider and base-URL compatibility checks. Values that do not name a stored
profile remain literal keys. Saving a key does not change the stored binding format.

## Setup replacements

Setup replacement credentials are saved under separate profile IDs with an
internal `setup` descriptor in the existing credential payload. They cannot
enter normal rotation, resolve through an explicit profile pin, or be copied to
another agent. Only the owning setup operation can test the selected credential.
After one successful tool-free turn, setup asks whether to activate it. Declining
or failing the test keeps the saved credential inactive and preserves the current
connection. Model Setup offers the same saved sign-in for a fresh test without
another login. If applying a replacement fails, recovery restores its inactive
state before rebuilding the previous connection. Gateway activation waits for
config application; a required restart keeps the replacement inactive until setup
is retried. Ordinary login remains immediate. The descriptor retains the selected
model and connection settings for retry after
restart, without caching a verification result. This adds no database schema or
migration; older runtimes do not enforce the inactive state. Before downgrading,
remove saved inactive replacements or restore the state from before setup.

Noninteractive setup saves replacement credentials and prints a
`openclaw models auth activate <profileId> --agent <id>` command to test and activate
the saved sign-in. Model Setup offers the same operation. Interactive setup defaults
to activation after a successful test. Reusing an existing credential
and first-run noninteractive setup retain their existing behavior.

## Agent copy portability

Agent auth inheritance is read-through. When an agent has no local profile, it resolves profiles from the shared auth store at runtime without copying secret material into its own credential store (`agents/<agentId>/agent/openclaw-agent.sqlite`). The shared store lives in `state/openclaw.sqlite` after `openclaw doctor --fix` performs the one-time relocation. Until then, doctor reports the legacy `agents/main/agent/openclaw-agent.sqlite` owner and leaves that agent undeletable.

When `agents.defaults.authInheritance.agentId` names another agent, Doctor relocates that agent's credentials if `main` has none. If both stores contain credentials, Doctor leaves both untouched and reports a recoverable warning: keep the credentials agents should share in one store, then rerun `openclaw doctor --fix`. Agent-private credentials stay local. This repair applies during relocation; it does not change stores that have already completed the shared-state cutover.

OAuth sibling synchronization writes the selected primary profile first, then the discovered shared owner before other siblings. This preserves read-through inheritance regardless of filesystem directory order. A shared owner outside the selected agents tree is not added to the synchronization targets.

Auth usage and cooldown updates wait for write admission on their actual agent
database owner, including the legacy shared store. Relocated shared-state auth
uses its own coordinator. Queued updates retain their selected state root and
shared owner, then read the current profile after admission. Runtime snapshots
publish after the durable commit and before the next admitted writer; removing
a profile while its health update waits does not recreate its health state.
Cold agent opens validate integrity asynchronously and recheck ownership before
writing.
OAuth upserts recheck the current local or inherited credential after admission,
before applying the existing generation-replacement rules.

Runtime auth-store updates keep their read, merge, encode, and commit in the
existing SQLite worker. Update callbacks execute at most once against the
transaction's current rows; live owner admission is checked again before commit.
Local updates refuse an observed shared-store change during preparation without
replaying callbacks. Large cells cross the worker boundary as bounded fields.
Shared credential publication reuses the committed shared store and leaves
unaffected local snapshots and their revisions intact. Resolved secrets remain
with their existing runtime owner.
Doctor auth repairs retain the native transaction owned by their schema-maintenance
lease; they do not borrow ordinary worker authority.
Model-catalog workers use their request's native auth-write scope, pinned to the
captured state root. The request waits for claimed OAuth refreshes to settle before
closing that scope; retained callbacks cannot write after it closes.
Each catalog request carries the Gateway's committed shared-store ownership. A
reused worker installs that fact before reading credentials, so the first login's
empty-store relocation cannot leave discovery attached to the legacy location.
Catalog preparation carries the persisted-store inspection result and selected
display path with the credential view. Labels reuse that source selection for the
request; the next refresh observes committed changes. External credential refresh
and the final credential authority check remain unchanged.
Temporary probe stores wait for their database work and shared-registry removal
before deleting credential files. If disposal fails, cleanup retains the directory
and reports its location.
Stored formats, schema versions, and update or rollback behavior are unchanged.

Inline API-key failure bookkeeping reads and updates the selected agent's auth
state through its existing SQLite worker. It preserves credential bytes and
other profiles' health state. Runtime snapshot publication reads stored local
and shared rows off-thread, then retains the current host's resolved secrets and
external profile overlays. A publication failure does not replay a committed
health update. The synchronous SDK store APIs retain their existing contracts.

Gateway model metadata refreshes when credentials, profile ordering or ownership,
or model availability changes, including cooldown and blocked-state transitions.
Usage timestamps, success history, and failure counters remain recorded without
invalidating chat metadata or broadcasting a change to connected clients.

Gateway model-auth status reads share provider preparation across clients for the
same agent and published config/auth generation. Credential warning and expiry
boundaries also invalidate preparation; explicit refresh bypasses it. Each reply
still computes current expiry durations, reads auxiliary usage from its existing
cache, and applies the requesting client's profile-identity visibility.
File-backed external CLI bootstrap health stays with its reader's freshness
lifecycle because external login can change without a Gateway publication.

Repeated model resolution reuses deeply frozen persisted auth rows while the
auth publication revision and owning database identity remain unchanged.
Committed auth writes, unclassified database writes, and runtime snapshot reloads
invalidate those rows immediately. Writes certified as session-only preserve
the same immutable rows without reading or freezing them again. Each request
retains its own live read authority; cache reuse cannot revive a revoked reader.
An auth read prepared before an agent database exists stays empty if the first
session creates that database. A later read observes the new file; replacement
of an already captured file still invalidates its read.
Scoped overlays, migration refusals,
and personal-account selection still run on each request. Isolated agent scopes
and private database snapshots do not share this cache. Gateway cache misses reuse
a read-only child whose lifetime ends at shutdown; each read reacquires its source
admission and closes its SQLite handles before returning.
Reader launches normalize the effective state directory, so an implicit default
and the same explicitly pinned directory reuse that child. A different state
directory, environment, or source still replaces it.
Detached connection, cron, heartbeat, and hook callbacks retain that Gateway's
read-only worker scope without inheriting startup or request authority. Shutdown
refuses late callbacks before they can create another reader.
Auth-file observation reuses the current Gateway's reader binding, including
directories discovered later by temporary requests. Publications stop when those
Gateway readers close; the next Gateway generation rebinds retained observers.
Usage bookkeeping invalidates later cache reuse while admitted reads can finish
their snapshots. Credential, selection, ownership, and lifecycle changes still
invalidate in-flight preparation.
Model selection retries that stale read once after its readers finish cleanup,
preserving the selected agent and any explicit profile pin. If an in-process OAuth
refresh invalidated the read, selection first observes that owner's durable
settlement, including inherited credentials and fenced peers. This wait uses the
existing refresh timeout and neither reads credentials nor starts another refresh.
Reconnects release waits for the replaced claim; readers of still-fenced peers
continue to wait for the owner's cleanup.
Pending refresh profiles remain candidates for model id/mode selection; the OAuth
owner still settles the refresh before credentials can be used. A caller timeout
does not retire its durable settlement from observation, and a waiting model read
cannot cancel it. Canceling a model request ends only its settlement wait; the
refresh owner and other waiting requests continue independently. Continued changes,
admission refusals, and cleanup failures remain errors.

Credential lookups through `resolveApiKeyForProvider` and
`resolveApiKeyForProfile` also accept an optional abort signal. Cancellation
ends the caller's wait for queued admission, a profile lock, or refresh. Queued
tasks recheck cancellation before claiming credentials. Started lock acquisition
retains its cleanup owner, and claimed refreshes keep their independent durable
settlement.
Canceled callers cannot start a later queued refresh or return its credentials.
Callers that omit the signal retain the existing wait behavior.

Workers certify committed SQLite visibility before rows enter the cache. Reads
with unpublished or trailing WAL frames return normally without being retained.

Explicit copy flows, such as `openclaw agents add`, use this portability policy:

- `api_key` and `token` profiles are portable unless `copyToAgents: false`.
- `oauth` profiles are not portable by default because refresh tokens can be single-use or rotation-sensitive.
- Provider-owned OAuth flows may opt in with `copyToAgents: true` only when copying refresh material across agents is known safe; the opt-in only applies when the profile carries inline access/refresh material.

Non-portable profiles remain available through the shared read-through base unless the target agent signs in separately and creates its own local profile.

During OAuth refresh, the current credential generation is replaced by an inert
durable marker. Pending markers remain ineligible by default and are ordered only
by runtime paths that immediately pass them to the settlement-aware resolver.
Failed markers are terminal and require the operator to authenticate again.
Native profile refreshes and serialized SDK AuthStorage use the same typed
provider-boundary recovery contract. They restore an exact claimed credential
only with positive evidence that dispatch never began, a documented
provider-specific guarantee that the grant remains reusable, or an explicit
owner-accepted provider retry policy. A missing response, connection reset,
timeout after dispatch, or arbitrary 429/5xx response does not prove
nonconsumption by itself.

- Google (managed Meet accounts and Vertex `authorized_user` ADC) and Microsoft
  (Teams delegated accounts) document their refresh grants as reusable. A lost
  or unreadable response, a timeout after dispatch, and an HTTP 429 or 5xx,
  including an HTML error page, keep the sign-in for a later refresh.
- xAI is the only owner-accepted retry policy. This changes earlier behavior,
  where an xAI 429 or 5xx was terminal. An HTTP 429 or 5xx token response now
  keeps the stored sign-in and a later refresh retries it, including transient
  or unrecognized OAuth `error` codes such as `temporarily_unavailable`. A lost
  or unreadable xAI response stays fenced.
- OpenAI, Anthropic, GitHub, X, MCP, Chutes, MiniMax, Radius and Twitch rotate
  grants or do not document reuse. A lost or unreadable response, timeout
  after dispatch or post-dispatch 429/5xx stays fenced and asks for reconnect.

Final OAuth errors, such as `invalid_grant` or `invalid_client`, stay terminal
at any status for every owner. xAI also treats `invalid_request` and
`access_denied` as final. Elsewhere a 4xx carrying them fences the sign-in as
an unknown failure, and a Google or Microsoft 429/5xx carrying them keeps the
reusable grant.
Unknown exceptions, invalid returned credentials (including a missing
`access_token` or an invalid replacement refresh token), and explicit token
rejection remain terminal. Vertex ADC stores no refresh claim, so it reports an
invalid returned token as retryable against its externally owned reusable
grant. A caller timeout does not roll back or
retry an in-flight owner. Callers already queued for the same owner and exact
credential share a settled transient failure instead of replaying that attempt;
a later new admission can retry. The auth-candidate caller owns health recording and the
normal bounded transient cooldown (initially 30 seconds, at most five minutes);
read-only runs and local failure policy never persist shared health updates.

Agent-local peers never receive copied rotated refresh material. A peer removes
its marker and inherits the shared credential only after verifying that the
shared credential belongs to the same account. If that identity cannot be
verified, the peer remains terminally fenced instead of inheriting another
account.

Catalog discovery fences and settles historical peers through the same
request-owned native writer as the refreshing credential. Each peer update
retains its captured database file identity and compares the credential inside
the write transaction. An identity-bound read skips definitely unrelated refresh
generations before write admission, so empty retained stores from completed agent
deletions do not block a shared-store refresh. Matching generations still require
write admission and remain blocked by completed deletion. Unreadable or
identity-replaced stores fail closed.
If peer fencing fails before the provider refresh starts, claimed credentials
are restored. After a native profile refresh finishes with an admitted retryable
failure, exact owner and peer claims are restored only under current credential
and caller authority, without replacing a newer login. Personal-account rollback
retains both the account locator and its current canonical owner's selection
authority across profile merges. Disconnecting or switching that owner's default
account during refresh prevents restoration, even for an explicit session pin.
The failed credential stays terminal and needs reauthentication; a default change
alone does not invalidate a usable, unrefreshed pin. A lost response may already
have consumed a rotating refresh token and cannot authorize another attempt with
that grant. Invalid returned credentials and post-success identity or settlement
failures remain fail-closed. Where an owner already retains a rotated result for
storage retry, it retries that storage operation, not the old token exchange.
External tool homes retain their own refresh authority; this contract does not
transfer their credentials into OpenClaw ownership.

## Long-running custom transport requests

The embedded run auth owner can supply a versioned, optional `requestAuth`
capability to provider `createStreamFn` factories. A participating transport
resolves it before each physical request, including private continuations, so a
captured attempt bearer cannot hide canonical renewal or rotation. Resolution
locks the original profile and account instead of trying another identity. Run
closure, auth selection changes, automation revocation and cancellation refuse
credentials, including after awaited preparation. Existing native OAuth owners
still own refresh grants and independent durable settlement.

Legacy hosts and entrypoints without this capability retain captured-key
behavior; ordinary just-in-time refresh between separate runs does not imply
renewal within one attempt. See [custom transport request credentials](/plugins/sdk-provider-plugins#per-request-credentials-in-custom-transports).

## Plugin SDK OAuth validation

`resolveApiKeyForProfile`, exported from `openclaw/plugin-sdk/agent-runtime`,
accepts an optional `validateOAuthCredential` callback. The resolver calls it
before returning an OAuth credential and before persisting or adopting a
refreshed credential. The callback also applies when a legacy
`provider:default` profile falls back to a replacement OAuth profile.

Throwing from the callback rejects that credential. A rejected fallback is not
returned or refreshed, and the original selected-profile refresh failure remains
the operator-facing error. Rejecting an active refresh or settlement generation
blocks credential access and can leave that generation and its peers terminally fenced, so
the operator must authenticate again. Callers that omit the callback retain the
existing resolution and fallback behavior.

`openclaw agent exec` preserves the original shared-store root when switching to temporary run state. Its bounded credential scope reads portable `api_key` and `token` profiles from that shared store without persisting copies; the configured agent's local profiles still win. Shared OAuth profiles are excluded from this temporary scope, even with `copyToAgents: true`, so the run does not acquire another refresh owner. `--auth-env-only` disables stored credential access entirely.

Auth writes that explicitly select a state directory, including isolated QA staging, use that directory's shared store for ownership and OAuth deduplication. Their runtime publication and rollback retain the same owner; another process-local state root is not an inherited base. An unrelated outer database may be older, newer, or unreadable without blocking an isolated write, but an unreadable or newer database in the selected target still blocks the write. Writes without an explicit state directory retain the normal ambient state and agent-directory configuration.

## Provider-boundary OAuth outcomes

`openclaw/plugin-sdk/provider-oauth-runtime` exports `OAuthRefreshOutcome`,
`createOAuthRefreshError`, `createOAuthRefreshResponseError`, and
`isRecoverableOAuthRefreshFailure`. Existing `refreshOAuth` and registered
`OAuthProviderInterface.refreshToken` signatures are unchanged: return the
refreshed credential or throw. The versioned structural error facts work across
plugin module graphs; they contain no tokens, raw responses, or client secrets.

An adapter that knows dispatch did not begin can throw:

```ts
throw createOAuthRefreshError(
  "OAuth refresh did not start",
  {
    version: 1,
    phase: "before-dispatch",
    outcome: "not-attempted",
    recovery: { kind: "later", evidence: "dispatch-not-started" },
  },
  { cause },
);
```

Use that evidence only when the adapter actually knows no request began. Merely
catching a fetch rejection before headers is insufficient. Response-level
`unchanged` outcomes require a documented guarantee for that route and grant;
status alone is not evidence. `owner-accepted-provider-retry` is not a reuse
guarantee: claim it only after an explicit product decision by that provider's
owner, because the classifier cannot verify it. Nested terminal OAuth reasons override recovery
hints. Unknown versions, contradictory facts, malformed success, and errors
after successful exchange cannot authorize restoration. Legacy
`oauthRefreshFailure.retryable` booleans remain presentation metadata but no
longer grant recovery permission by themselves.

The credential owner still controls exact-generation claims, current authority,
conditional commit, and cleanup. An adapter cannot manufacture a receipt that
those durable steps completed. Model profiles, serialized SDK storage, and
non-model account owners share the classification, not a universal HTTP client
or a second credential manager.

### Non-model and externally owned routes

GitHub shared/personal accounts, MCP client OAuth, Teams delegated accounts,
X user OAuth, managed Meet accounts, and refreshable Twitch accounts retain
their existing account/storage boundaries. Returned rotation must be persisted
conditionally before access is published. Caller cancellation ends observation,
not an already-dispatched owner's settlement.

Vertex `authorized_user` ADC remains read-only external input. Its selected file
and client/grant identity scope the access cache and in-process refresh coalescing.
OpenClaw does not persist a claim against that externally owned grant. An
unexpected replacement refresh token is an actionable unsupported-rotation
error, never silently discarded or written back to gcloud's file. Other ADC
kinds continue through GoogleAuth. One-shot Meet grants likewise cannot silently
discard returned rotation; managed Meet accounts have a conditional plugin-state
owner.

Copilot model credentials are a local projection, not a rotating refresh-token
HTTP route. Anthropic setup tokens, OpenRouter API-key provisioning, static
channel tokens, and tool-owned Claude/Codex/Muse/MiniMax homes are not native
refresh grants. Gemini CLI dispatch is tool-owned; historical Gemini profiles
lack a native OpenClaw refresh adapter with verified original client provenance.
That native route remains explicitly unsupported rather than borrowing a
different Google client or taking over a CLI home.

### Recovering an interrupted rotating refresh

A pending rotating-grant claim left by a crash is not automatically released
after a timeout. The provider may already have consumed it; restarting or
deleting a database marker is not evidence that the old grant is safe to retry.
When an uncertain-outcome error asks for sign-in, obtain a new grant through the
existing credential owner:

- System or agent model profiles: run `openclaw models auth login --provider <id>`
  for the affected agent/profile. Personal model accounts reconnect from
  **Settings → Profile → Connected accounts**, not the system auth store.
- Shared MCP OAuth: run `openclaw mcp logout <name>`, then
  `openclaw mcp login <name>`. Per-requester MCP users use their own sign-in flow.
- GitHub accounts: reconnect the affected shared or personal connection through
  its existing account setup, preserving the intended account identity.
- Twitch: reauthorize the configured bot account and replace its configured
  access/refresh grant together. This includes a Twitch 429/5xx or lost refresh
  response, because Twitch does not document reuse of the old grant after a
  possibly completed rotation. Do not clear plugin state to replay the old
  refresh token. A saved completed rotation retries only identity validation;
  it does not repeat the token exchange.

Google Meet and Microsoft delegated grants retain their documented reusable
refresh material for later recovery, including after a lost, unreadable or HTML
error response, but explicit rejection still requires
reauthorization. Vertex ADC remains under its external credential owner. No
recovery procedure should copy a different person’s grant or edit live SQLite
rows manually.

## Personal model accounts

Accounts connected from **Settings → Profile → Connected accounts** have an identity-scoped owner in the shared state database. Their credentials and usage state never enter shared or agent-local auth stores, external CLI mirrors, or global runtime snapshots. A runtime loads at most the one personal credential selected by its session. Unlinked personal accounts remain usable by existing session pins, not by automatic selection for new sessions.

Personal pins keep the existing same-provider failover policy: ordered shared accounts can be tried after a pinned account fails. They do not make another person's personal account a fallback. Reconnecting can replace only the connecting person's own credential; shared credentials referenced by an administrator-created link are not personal property. See [Per-person model accounts](/concepts/multi-user#per-person-model-accounts).

## Config-only auth routes

`auth.profiles` entries with `mode: "aws-sdk"` are routing metadata, not stored credentials. They are valid when the target provider uses `models.providers.<id>.auth: "aws-sdk"`, the route the plugin-owned Amazon Bedrock setup writes. These profile ids may appear in `auth.order` and session overrides even when no matching entry exists in the credential store.

Do not write `type: "aws-sdk"` into the credential store; stored credentials are only `api_key`, `token`, or `oauth`. If a legacy `auth-profiles.json` has such a marker, `openclaw doctor --fix` moves it to `auth.profiles` and removes the marker from the store.

When a selected stored profile is removed, credential-scoped model discovery reports `selected_auth_profile_unavailable` before consulting dynamic model metadata. Restore the credential or select another configured profile; registering the model does not repair missing authentication. Config-only AWS SDK profiles remain valid without a stored credential. Chat admission and agent commands retain an explicit same-provider selection when its credential disappears so authentication can report recovery. Stale automatic selections and selections for incompatible providers are still cleared.

OAuth re-authentication preserves an existing profile id only when the provider's account-identity matcher proves that the new credential belongs to the same account. A different or ambiguous account keeps the provider's new profile id, so explicit session pins do not cross account boundaries. Unavailable pins remain strict and emit a session-scoped warning. For a credential already removed before re-login, deliberately select a configured account with `model@profile`, or reconnect the intended account with `openclaw models auth login --provider <provider> --profile-id <selected-profile-id>`. No session rows or stored credentials are rewritten during upgrade.

## Explicit auth order filtering

- When `auth.order.<provider>` or the auth-store order override is set for a provider, `models status --probe` only checks profile ids that remain in the resolved auth order for that provider. The stored override wins over `auth.order` config.
- A stored profile for that provider that is omitted from the explicit order is not silently tried later. Check output reports it with `reasonCode: excluded_by_auth_order` and the detail `Excluded by auth.order for this provider.`
- A valid session user pin is an explicit per-session exception: OpenClaw tries that profile first even when it is omitted from the provider order, then uses the ordered same-provider profiles as retry candidates. A cooldown or disabled window applies only to the affected profile; it does not suppress its eligible siblings.

Prepared agent requests use their selected plugin metadata, configuration, workspace, and environment for auth profile eligibility, ordering, and environment credential evidence. An empty selected plugin set remains authoritative; another request’s plugin aliases cannot add profiles or change the credential owner.

## Model catalog discovery

Stored-profile selection for model discovery follows the resolved auth order and
eligibility rules. A cooldown limited to one model does not suppress account-wide
catalog discovery. Configured subscription modes remain attached to direct
credentials, and successful OAuth preparation supplies the resolved current token
to its catalog consumer rather than the captured store's older token.

Deferred provider catalogs retain discovered models when a configured SecretRef
has a matching credential in the active runtime snapshot. Catalog admission uses
that credential only as availability evidence: it does not resolve the reference
again or copy the value into model rows. Unresolved references and credentials
retained in a generated catalog do not grant admission.

Environment-backed profiles keep usable values from the discovery environment,
including cold command and worker paths. When that material is missing, only the
selected profile's activated snapshot may supply it; otherwise discovery reports
`unavailable` before catalog HTTP. Reference names are never sent as credentials
or replaced with another profile's credential. On a Gateway, restore the secret
and run `openclaw secrets reload` before retrying discovery.

When every eligible OAuth candidate fails preparation, discovery reports
`unavailable` with the attempted profile identities instead of treating the
provider as unconfigured. Compatible prior inventory remains available. A usable
fallback credential still supplies its own catalog result.

When a catalog deadline expires, late provider results are discarded before
finalization. An already-started hook or OAuth refresh may finish, including
persisting a rotated credential, but cannot publish to the expired catalog run.

API-key-oriented and full-auth catalog callbacks retain their existing source
priorities. Plugins must keep credential bytes and their authentication mode from
the same selection. Catalog failure and recovery preserve the
[model inventory contract](/concepts/models#selection-source-and-fallback-strictness);
they do not change message-execution profile rotation or session pins.

<a id="probe-target-resolution" />

## Check target resolution

- Check targets can come from auth profiles, environment credentials, or `models.json` (result `source`: `profile`, `env`, `models.json`).
- If a provider has credentials but OpenClaw cannot resolve a model candidate that can be tested for it, `models status --probe` reports `status: no_model` with `reasonCode: no_model`.

## External CLI credential discovery

- Supported external CLI credentials are discovered only when the provider, runtime, or auth profile is in scope for the current operation, or when a stored local profile for that external source already exists.
- Auth-store callers choose an explicit external-CLI discovery mode: `none` for persisted/plugin auth only, `existing` for refreshing already stored external CLI profiles, or `scoped` for a concrete provider/profile set.
- Read-only/status paths pass `allowKeychainPrompt: false`; they use file-backed external CLI credentials only and do not read or reuse macOS Keychain results.
- `/models` reuses external login evidence already prepared with its catalog, so those providers remain visible without a second OpenClaw login. Opening the default menu does not repeat external CLI discovery; explicit auth order and route compatibility still apply.

Codex owns its native login. Ordinary status and model reads do not import its
credentials into OpenClaw profiles. To retain a configured CLI-backed
`openai:default` profile, explicitly import the current Codex login with
`openclaw models auth login --provider openai --method device-code`. When that
OAuth profile is declared in `auth.profiles`, the source is the current native
Codex home, and no other managed OpenAI OAuth profile exists, import preserves
the profile ID and its existing model and session pins. The configured model
and native credential file stay unchanged. An explicitly isolated agent home
continues to use the imported OpenClaw profile through its isolated runtime.

Since 2026.9.5, native Codex login no longer supplies the runtime-only
`openai:default` profile. If that OAuth profile is still declared but absent from
an agent's credential store, `openclaw doctor --fix`, Doctor lint, and
Gateway startup warn with the import command above. The warning does not copy
credentials or block the update. Missing-profile errors identify local store
absence without reporting a provider HTTP 401; the error records a local lookup
failure, not a provider rejection.
For multiple agents, add `--agent <id>` to the login command to select the
affected agent.

Fresh imports keep account-scoped profile IDs. A matching existing account and
user reuse their stored profile. Import from another home, missing account/user
identity, or an existing managed account does not claim the legacy pin. Use the
reported imported profile explicitly in those cases. Source changes and
conflicting profiles detected before persistence stop only the selected import.

## OAuth SecretRef Policy Guard

SecretRef input is for static credentials only. OAuth credentials are runtime-mutable (refresh flows persist rotated tokens), so SecretRef-backed OAuth material would split mutable state across stores.

- If a profile credential is `type: "oauth"`, SecretRef objects are rejected for any credential material field on that profile.
- If `auth.profiles.<id>.mode` is `"oauth"`, SecretRef-backed `keyRef`/`tokenRef` input for that profile is rejected.
- Violations are hard failures (thrown errors) in startup/reload secret preparation and profile resolution paths.

## Legacy-Compatible Messaging

When an empty SQLite auth store has a retired `auth-profiles.json` beside it,
runtime inspects provider metadata without importing or resolving its credentials.
`AUTH_PROFILE_MIGRATION_REQUIRED` blocks only those providers, including their auth
aliases; unrelated provider auth remains available. Unreadable or unrecognized
legacy data retains the owner-wide refusal. A populated SQLite store retains its
warning-only behavior. Recorded refusals remain until the lifecycle explicitly
clears them; changing or removing a legacy file does not release them. Doctor lists the affected providers, and
`openclaw doctor --fix` performs the supported verified import and archive.

Session readers retain their local and shared auth-store owners and check each
owner's current refusal before returning credentials. A shared-provider refusal
does not replace an unrelated local credential with environment or config auth,
and unresolved local SecretRefs still block credential access. Only recognized credential
entries can narrow a legacy refusal; metadata-only objects and unknown layouts
remain owner-wide.

Credential writes check migration readiness owner-wide for their destination
database only. A shared-store refusal does not block refreshing an unrelated
agent-local OAuth credential; a refusal on the write destination still blocks it.

Session migration guards use the same pinned runtime config as model discovery
and the requested model's endpoint to resolve endpoint-dependent provider aliases.
Prepared session views retain stored profiles from both owners and validate
their SecretRefs; migration metadata does not filter these profiles. The
endpoint-aware request guards decide admission. Each selected credential also
retains its physical source owner through merges and async resolution. A refusal
held by that owner continues to fence matching credentials imported by another
process until an explicit lifecycle clear/reload. The other owner's credentials
remain independent. This provenance is runtime-only and is never stored in SQLite.
If the requested provider needs
an endpoint to identify its credential realm and that context is missing, any
pending migration refusal blocks it. An explicitly configured unrelated endpoint
remains usable.

For script compatibility, check errors keep this first line unchanged:

`Auth profile credentials are missing or expired.`

Human-friendly detail and the stable reason code follow on subsequent lines in the form `↳ Auth reason [code]: ...`.

## Client identities and paired tokens

Client private identities and paired device-token caches live in the separately
versioned local `client/credentials.sqlite`, including when the Gateway uses
PostgreSQL. These are distinct from model-provider auth profiles. Native bootstrap
does not open the selected Gateway database. Gateway-issued pairing and revocation
remain under the Gateway's authority; a local cache does not grant authorization.

Migration preserves exact private keys, tokens, scope strings, and timestamps.
Legacy JSON imports record consumption atomically with the local write. Revocation
retains that record, so a restored or rewritten legacy file cannot resurrect its
token. Refresh and removal compare the observed token with the current local row.

If the shared SQLite main file is missing while its WAL, shared-memory file, or
rollback journal remains, credential startup and session import require recovery.
Restore the matching main database and sidecars before retrying. OpenClaw does not
create a replacement identity from an incomplete source.

Automatic rollback restores the pre-upgrade shared credentials. Credentials issued
between upgrade and rollback are lost; affected clients pair again. A subsequent
upgrade rebuilds any stale local store from the restored shared source. See
[credential migration and recovery](/reference/database-schemas/versioning#local-client-credentials).

## Related

- [Secrets management](/gateway/secrets)
- [Auth storage](/concepts/oauth)
- [SecretRef credential surface](/reference/secretref-credential-surface) - which credential fields accept a SecretRef instead of a raw secret value
