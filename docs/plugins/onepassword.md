---
summary: "Resolve SecretRefs and give agents curated, audited access to 1Password"
read_when:
  - You want agents to request curated 1Password secrets
  - You want OpenClaw config credentials to resolve from 1Password
  - You need per-secret approval policy and audit history
  - You are configuring a 1Password service account for OpenClaw
title: "1Password plugin"
---

# 1Password

The bundled `onepassword` plugin has three independent, opt-in surfaces:

- a managed exec provider that resolves configured [SecretRefs](/gateway/secrets)
  during Gateway startup, reload, audit, and apply preflight
- a policy-controlled agent tool that reads a curated set of 1Password fields
- an [Agentic Autofill preview](#agentic-autofill-preview) for browser sign-in
  without returning login values to the model

The first two use the official `op` CLI and the same service-account token file.
Enabling the plugin alone does not expose either agent tool: curated-secret
access requires an item registry, and Agentic Autofill has a separate opt-in.

## Security model

The service-account surfaces have the following security properties. Agentic
Autofill has a [separate security model](#privacy-storage-and-disconnection).

- Service-account authentication only. The token stays in a local credentials
  file and is never accepted in `openclaw.json`.
- Curated agent registry only. Agents can list configured slugs, but the plugin
  never enumerates a 1Password vault. SecretRef reads are limited to references
  explicitly stored on registered OpenClaw credential targets.
- Per-slug `auto`, `approve`, or `deny` policy.
- Approval grants expire. A cached value never bypasses current policy.
- Every access attempt is recorded in OpenClaw's shared SQLite state. Audit
  rows include the supplied reason; keep reasons non-sensitive. The broker
  never copies a fetched value or the service token into an audit row.
- A successful `get` value reaches the model and remains in tool results and
  persisted transcripts without secret masking. Later tool calls and replies
  can also contain it. Keep policies narrow, protect transcripts, and review
  conversation text before sharing it.
- The plugin invokes `op` once per cache miss. It does not retry rate limits or
  other failures.
- Each `op` call runs with a minimal environment that disables 1Password
  desktop-app integration (`OP_LOAD_DESKTOP_APP_SETTINGS=false`,
  `OP_BIOMETRIC_UNLOCK_ENABLED=false`), so a 1Password app installed on the
  Gateway host never triggers biometric or macOS permission dialogs.

Give the service account read access only to the vaults and items used by
registered SecretRefs and agent-tool slugs.

## Before you begin

You need:

- the 1Password CLI (`op`) installed on the Gateway host
- a 1Password service account with access to the selected items
- a dedicated service-account token file

Enable the bundled plugin:

```bash
openclaw plugins enable onepassword
```

Create the token directory and file under the OpenClaw state directory:

```bash
mkdir -p ~/.openclaw/credentials/onepassword
chmod 700 ~/.openclaw/credentials/onepassword
printf '%s' "$OP_SERVICE_ACCOUNT_TOKEN" > \
  ~/.openclaw/credentials/onepassword/service-account-token
chmod 600 ~/.openclaw/credentials/onepassword/service-account-token
unset OP_SERVICE_ACCOUNT_TOKEN
```

When `OPENCLAW_STATE_DIR` is set, replace `~/.openclaw` with that directory.
The plugin warns once when the token file is readable or writable by group or
other users.

## Configure SecretRefs

Create a secrets apply plan for common model provider keys:

```bash
openclaw onepassword secretref setup \
  --anthropic-id op://Automation/Anthropic/credential \
  --openrouter-id op://Automation/OpenRouter/credential \
  --plan-out ./openclaw-1password-secrets-plan.json
```

Use `--provider-key <provider=id>` for another model provider, or
`--target <path=id>` for any registered
[SecretRef credential target](/reference/secretref-credential-surface).
The command requires at least one target and writes a plan. Inspect it, check
the local `op` and token-file prerequisites, then apply and reload:

```bash
openclaw onepassword secretref status
openclaw secrets apply --from ./openclaw-1password-secrets-plan.json --dry-run --allow-exec
openclaw secrets apply --from ./openclaw-1password-secrets-plan.json --allow-exec
openclaw secrets audit --check --allow-exec
openclaw secrets reload
```

Before apply, status can report that the provider itself is not configured yet;
`prerequisites ready: yes` confirms that the trusted `op` executable and an
accepted non-empty token file are ready. After apply, `ready: yes` confirms both the
provider wiring and prerequisites. Missing or unsafe prerequisites produce
actionable next steps without printing the token or raw resolver errors.

Manual provider configuration uses the existing plugin id:

```json5
{
  plugins: {
    entries: {
      onepassword: { enabled: true },
    },
  },
  secrets: {
    providers: {
      onepassword: {
        source: "exec",
        pluginIntegration: {
          pluginId: "onepassword",
          integrationId: "onepassword",
        },
      },
    },
  },
  models: {
    providers: {
      openai: {
        apiKey: {
          source: "exec",
          provider: "onepassword",
          id: "op://Automation/OpenAI/credential",
        },
      },
    },
  },
}
```

References use `op://<vault>/<item>/<field>` or
`op://<vault>/<item>/<section>/<field>`. Vault, item, section, and field names
may contain spaces. The setup command stores references that do not fit
OpenClaw's shared exec-id grammar in a plugin-local opaque form and decodes them
only inside the resolver. Very long references should use stable 1Password IDs;
they are shorter and reduce the number of 1Password API requests.

The SecretRef resolver runs at most four `op read` processes concurrently,
disables the 1Password CLI cache so reloads observe rotated values, never uses
desktop-app integration, and does not expose an agent tool for arbitrary reads.
Before passing the service-account token, both plugin surfaces
resolve the executable and reject paths that another local account can replace;
Windows ACL verification must also succeed. Check provider wiring and local
readiness with:

```bash
openclaw onepassword secretref status --json
```

## Configure registered secrets

Add plugin config to `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "onepassword": {
        "enabled": true,
        "config": {
          "vault": "Automation",
          "defaultPolicy": "approve",
          "cacheTtlSeconds": 300,
          "grantTtlHours": 720,
          "opTimeoutMs": 15000,
          "items": {
            "repository-token": {
              "item": "Repository automation token",
              "field": "credential",
              "policy": "approve",
              "description": "Token for repository automation",
            },
            "model-key": {
              "item": "Model provider key",
              "vault": "Agent credentials",
              "policy": "auto",
            },
          },
        },
      },
    },
  },
}
```

Slugs use lowercase letters, numbers, and hyphens, start with a letter or
number, and contain at most 64 characters. A registry can contain up to 32
slugs; descriptions can contain up to 200 characters. `field` accepts one field
label or ID, must not contain a comma, and defaults to `credential`.
An item-level `vault` overrides the default vault. `opBin` can set an absolute
path to the `op` executable; otherwise the plugin resolves `op` from `PATH`.
Item titles must not start with a hyphen.

## Use the agent tool

The tool name is `onepassword`.

List registered slugs:

```json
{ "action": "list" }
```

The result contains only the slug, description, policy, and whether a standing
grant is active. It never contains a secret value and does not query 1Password.

Request one secret:

```json
{
  "action": "get",
  "slug": "repository-token",
  "reason": "Authenticate the requested repository operation"
}
```

`reason` is required, must be non-empty, and is limited to 300 characters. A
successful `get` returns the value plus the configured slug, item title, and
field label.

The tool schema also declares an internal `authorizationNonce` parameter. The
policy layer injects it after evaluating the request to hand the authorization
to the executing tool call. Never set it manually: the policy hook overwrites
any supplied value, and an unknown value fails the request.

## Policy tiers and approvals

- `auto`: fetch immediately and audit the request.
- `deny`: block and audit the request.
- `approve`: use an unexpired standing grant, or ask a human to allow once,
  always, or deny.

Allow once authorizes only the current tool call. Allow always writes a standing
grant for that agent and slug to SQLite; other agents must receive their own
approval. OpenClaw offers allow always only when the caller has a concrete agent
identity. The grant expires after `grantTtlHours`, which defaults to 720 hours.
An unresolved or timed-out approval denies the request; the maximum approval
wait is 600 seconds. The plugin retains up to 1,024 standing grants; at that
bound, the oldest grant is evicted and its agent must approve the next access.

Each evaluated authorization is single-use and is handed to the executing tool
call through shared SQLite state, so the handoff also works when more than one
plugin instance is active in the gateway process. Unused authorizations expire
after the 600-second approval window.

Pending authorization reads and writes run on the SQLite worker. Tool execution
waits for an approval's pending write to finish before consuming it; a failed
write fails the request without retrieving a secret. Existing pending rows and
their expiry remain compatible across updates.

The in-memory cache defaults to 300 seconds and is bounded by the configured
slug registry. Set `cacheTtlSeconds` to `0` to disable it. Policy is evaluated
before every cache lookup, and cache hits are audited. Runtime config reloads
take effect at each policy and execution boundary; disabling the plugin or
removing, denying, or retargeting a slug invalidates pending authorization and
cached values.

## Inspect status and audit history

Show readiness and registry counts:

```bash
openclaw onepassword status
```

This reports whether the token file exists, whether `op` resolved and its path,
the registered item count, and per-policy counts. It never reads or prints the
token or secret values.

Show the 50 most recent audit rows:

```bash
openclaw onepassword audit
openclaw onepassword audit --limit 100
```

Rows are newest first and show timestamp, agent, slug, outcome, an `errorCode`
when the attempt failed, and a truncated reason. The reason is stored as
supplied; the broker never adds the fetched value to the audit log.

## 1Password CLI behavior

The SecretRef resolver runs `op read`. On a nonzero exit, its protocol error
includes up to 512 characters from the end of stderr after secret redaction.
It removes the service-account token and any captured secret stdout from that
detail. Both output streams are capped at 64 KiB; exceeding either cap stops
the read and returns an output-limit error without child output. Gateway
degradation warnings still use generic provider failure reasons. After fixing
the underlying problem, run `openclaw secrets reload` to retry cold owners.

Each cache miss runs `op item get` with the configured item, vault, and exact
field selector, JSON output, a bounded timeout, and `--cache=false`. The child
receives only that field rather than the full item. Only
`OP_SERVICE_ACCOUNT_TOKEN` and `HOME` are present in the child environment.

The plugin makes one attempt. `RATE_LIMITED` errors should be handled by waiting
before a later agent request; the plugin does not create an automatic retry
loop.

## Error codes

Failed attempts carry one closed error code in the tool result and the audit
row.

1Password access errors:

| Code              | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `TOKEN_MISSING`   | Token file is missing or empty                                   |
| `OP_NOT_FOUND`    | `op` binary could not be resolved                                |
| `ITEM_NOT_FOUND`  | Configured item is not in the vault                              |
| `FIELD_NOT_FOUND` | Configured field is not on the item; available labels are listed |
| `RATE_LIMITED`    | 1Password service-account rate limit reached                     |
| `AUTH_FAILED`     | Service-account authentication failed                            |
| `TIMEOUT`         | `op` exceeded `opTimeoutMs`                                      |
| `OP_ERROR`        | Any other `op` failure or invalid output                         |

Policy and validation errors:

| Code                                               | Meaning                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `INVALID_ACTION`, `INVALID_REASON`, `INVALID_SLUG` | Request failed input validation                                              |
| `UNKNOWN_SLUG`                                     | Slug is not in the configured registry                                       |
| `TOOL_CALL_ID_MISSING`                             | Call arrived without a tool call id                                          |
| `POLICY_NOT_EVALUATED`                             | No matching authorization for this call; the request was not policy-approved |
| `POLICY_CHANGED`                                   | Config changed between approval and execution                                |
| `GRANT_EXPIRED`                                    | Standing grant lapsed before execution                                       |
| `APPROVAL_CANCELLED`                               | The run was aborted while the approval was pending                           |

## Related

- [Secrets management](/gateway/secrets)
- [1Password](/gateway/1password) — the built-in `op://` secret source, and how the plugin, skill, and MCP options compare
- [`openclaw secrets`](/cli/secrets) — store, reload, audit, configure, and apply SecretRefs from the CLI

## Agentic Autofill preview

Agentic Autofill is a separate opt-in for signing in with **your own logins**,
without returning their values to OpenClaw or the model. It does not use `op` or
change the existing SecretRef and curated-secret features above.

**Integration status:** the browser adapter is wired through the managed browser
extension host. Sensitive approval-link delivery remains intentionally unsupported;
normal chat delivery is not used because it mirrors links into model-visible
history. Enabling this preview alone does not provide working approval delivery.

### Setup and consent

Enable the plugin and its preview in your existing configuration:

```json5
{
  plugins: {
    entries: {
      onepassword: {
        enabled: true,
        config: {
          agenticAutofill: {
            enabled: true,
            extensionPath: "/operator-managed/1password-nightly",
            browserProfile: "openclaw",
          },
        },
      },
    },
  },
}
```

New plugin-owned config keys are `agenticAutofill.extensionPath` (the absolute
path to an operator-vetted unpacked extension) and `agenticAutofill.browserProfile`
(the dedicated local managed profile your agent uses). Both must be supplied when
the preview is enabled. `agenticAutofill.enabled` still defaults to `false`.

Install full Playwright Chromium using the [browser setup instructions](/tools/browser).
Install and unpack 1Password Nightly 8.12.46.6 or later yourself, retaining its
manifest `key` so the ID remains `gejiddohjgogedgjnonbofjigllpkmbf`. OpenClaw does
not download, verify signatures, or update this operator-managed directory.
Stop the profile before enabling the preview and restart the Gateway: the plugin
reserves that profile before browser launch. Do not modify extension files while
the profile is running. Use this profile for the Gateway owner's browser only;
it must not contain another person's signed-in extension state.

The tool
is optional; allow `onepassword_autofill` in your agent's tool policy when needed.
Restart the Gateway after enabling the feature. No OAuth client secret goes in
OpenClaw configuration.

With that Gateway running:

```bash
openclaw onepassword connect
openclaw onepassword autofill-status
openclaw onepassword disconnect
```

`connect` prints an HTTPS connect URL and confirmation code, then waits up to ten
minutes for consent. Open the URL on your own device, verify that the code
matches, and continue to 1Password. These two public fields can also be returned
by the `onepassword_autofill` tool's `connect` action; its subsequent `connect`
call with the returned session ID picks up the result. Pending sessions are
memory-only: if the Gateway restarts, start consent again.

This preview is Gateway-owner-only in chat; CLI operations require Gateway admin
access. It does not derive a human identity from an agent ID or a channel sender
string. Only one 1Password connection is selected per Gateway, and each browser
must belong to that one person. Disconnect the old connection before connecting
a different account. Multi-user personal connections are not supported yet.

### Request, approve, fill

Once a private approval delivery adapter is available, request a task's logins together (one to five
entries). Each entry has an HTTPS website, a short reason (100 characters), and
optional keywords (up to five, each 50 characters). The task goal is limited to
140 characters. Keep secrets, personal messages, and account identifiers out of
all request text.

The extension returns a sensitive `onepassword://` approval link. Plugin code
hands it only to a private, authenticated delivery adapter, never to the model,
transcript, or ordinary message sender. A channel that cannot deliver and open
that scheme reports `approvalDelivery: unsupported`; do not ask the model to
copy or reconstruct the link. A dedicated sensitive-link transport is required.

Chat cannot observe when a person opens a link. Automatic status checks therefore
start only after the person explicitly confirms opening it. There are no checks
for five seconds; checks then run every two seconds to 30 seconds, every five
seconds to one minute, and every ten seconds to two minutes, then stop. Rate
limits impose at least a 60-second connection-wide backoff. After the window,
tell the agent when you have approved: it can check once more. A still-pending
request needs a new approval prompt, not an indefinite polling loop. Final and
unknown states are saved and never polled again.

Grants are matched by entry ID, not array order. Unrequested grants are not
exposed for filling. OpenClaw restricts fill to the conversation and request
that created the grant. The browser adapter enables Agentic Mode and locks
the tab against screenshots, DOM reads, and other browser commands until fill
and submit finish. It releases its tab-scoped Agentic Mode before unlocking.
The worker attachment stays open across polling calls and closes on plugin shutdown. `fill_submitted` means the form was submitted, **not** that
the website accepted the sign-in; check the page afterward.

### Requirements and limits

The current 1Password partner preview requires:

- a US (`1password.com`) Individual or Family account; ordinary Business user
  consent is not supported by the upstream preview
- logins in your own vault (Personal or Private), not shared vaults
- a Nightly 1Password desktop app on the device where you approve
- a Chromium browser that supports extensions, with 1Password Nightly
  8.12.46.6 or later; unpacked extension loading needs Chromium or Chrome for
  Testing, not branded Google Chrome
- browser access to `api.1password.com`, `my.1password.com`, and
  `crl.1passwordservices.com`

Mobile standalone approval links and general browser-popup approval are still
in development upstream. Multi-page sign-in can fill the same granted entry on
each page. Social-sign-in method pickers are not supported.

### Privacy, storage, and disconnection

OpenClaw and the model do not handle login values. The browser extension does
handle values briefly between fill and submit, so browser isolation matters.
The Gateway holds OAuth tokens, the integration key, and granted opaque
references in its private SQLite plugin state, keyed by the integration key's
exact client/account/user path. This has the same local file-protection class as
OpenClaw OAuth credentials (private database and directory); it is **not** an
encrypted-at-rest vault. Protect the Gateway account and its backups accordingly.
Only current access tokens and the integration key enter browser memory; refresh
tokens never do.

`https://connect.openclaw.ai` performs OAuth exchange and refresh. The relay sees
OAuth tokens, but the integration key is sealed in the user's callback page to
a per-attempt Gateway key using ECDH P-256, HKDF-SHA256, and AES-256-GCM. It does
not receive the integration key in plaintext. Connect URL/code are public;
pickup tokens, keys, approval links, and references never enter tool results.

Access tokens refresh one minute before expiry and rotated tokens replace the
whole credential row atomically. An `invalid_grant` ends the connection and
removes its grants; reconnect to continue. A missing integration key on repeated
consent never erases the saved key. If the returned user identity cannot uniquely
match a saved key, OpenClaw revokes the new consent and asks you to reconnect.

`disconnect` revokes directly with 1Password and deletes local credentials and
references only after successful revocation. Failure preserves them so you can
retry. Revocation ends **all** grants for the connection; upstream grants
otherwise last 30 days at launch and can be filled repeatedly for their approved
task. A crash after upstream refresh but before local persistence can require
reconnection; the plugin never blindly retries a one-use refresh token after a
known successful rotation.

### Troubleshooting

- `extensionNotReady`: check `openclaw onepassword autofill-status`. Stop the
  profile, verify `extensionPath`, Nightly version and manifest key, and restart
  the Gateway. Use Chromium or Chrome for Testing, not branded Chrome. The
  profile must not already be running at registration. An unavailable API can
  also mean blocked feature-flag access to `my.1password.com`; see the upstream
  [managed browser policy](https://www.1password.dev/agentic-autofill/partners/browser-policy.md).
  The plugin does not write system browser policy; whole-browser Agentic Mode
  policy must not conflict with the adapter's tab-scoped enable/release calls.
  Status probes launch the owned browser if needed, without requesting access.
- `approvalDelivery: unsupported`: your channel lacks a private, non-transcript
  link transport. Do not put the approval link in a normal message.
- `gatewayOwnerRequired`: use an authenticated owner conversation; an agent ID
  or arbitrary channel sender is not a personal credential identity.
- `integrationKeyMissingReconnect`: new consent did not issue a key and no
  uniquely matched saved key exists. Revocation has completed; connect again.
- `reconnectRequired`: 1Password ended the connection; connect and approve again.
- `rateLimitExceeded`: wait at least a minute before asking for another check.
- `autosubmitFailed`: 1Password clears its filled values. Use another sign-in
  method and report the website to 1Password.
- Gateway method unavailable: enable the preview in the running Gateway and
  restart it; CLI processes never create a second credential-state writer.
