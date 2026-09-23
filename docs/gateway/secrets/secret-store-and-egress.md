---
summary: "The shared secret store, the default-off secret egress proxy, and file-backed API keys"
read_when:
  - Storing team-wide secrets and environment values in the shared secret store
  - Enabling the destination-bound secret egress proxy or its traffic allowlist
  - Running a Crabbox application with a configured model credential kept on the host
title: "Shared secret store and egress proxy"
---

This page covers the shared secret store, the default-off secret egress proxy and its traffic allowlist, and file-backed API keys.

## Shared secret store

The shared secret store is a Gateway-wide, team-scoped place for secrets and environment values that should be available to every Gateway process using the same state database. Manage it from **Settings → Secrets** in the Control UI or locally with `openclaw secrets store`. The CLI commands operate on the local state database and do not accept Gateway URL or token options.

Entries have two explicit access modes. Both retain the existing `secret` and `env` storage kinds, and either kind can back a SecretRef:

- **Protected secret** (`kind: "secret"`) values are write-only after saving. Gateway list results, the Control UI, and CLI list/get output never include them; there is no reveal RPC. A protected value is inert until a supported config field references it with a SecretRef or an enabled, destination-bound [secret egress proxy](#secret-egress-proxy) uses it.
- **Agent-readable environment** (`kind: "env"`) values remain visible to administrators in the Control UI and can be returned by `store list` and `store get`. OpenClaw adds them as plaintext to Gateway-hosted commands run through its exec tool, after inherited process values and before explicit per-call env. The agent can print, transmit, or persist these values. Protected host keys are ignored with a visible warning.

Agent-readable environment values do not reach Codex native shell, the Codex sandbox exec-server, ACP children such as Claude Code, OpenClaw sandbox exec, or remote `node` exec. Those paths assemble a different child environment. In eligible Codex app-server turns, use `gateway_exec` to deliberately re-enter the OpenClaw Gateway execution path; `gateway_process` provides the existing per-session background follow-up. Native Codex shell remains preferred for ordinary local work. Gateway-hosted exec captures the store snapshot on its first execution in a run. Later additions, replacements, deletions, and host edits require a new run; storing a credential does not refresh an already-captured exec snapshot.

By default, `secret` entries are never injected into subprocess environments. When the default-off [secret egress proxy](#secret-egress-proxy) is enabled, Gateway-hosted exec commands receive process-local sentinels instead of plaintext values.

Names use the same uppercase grammar as env SecretRefs, and each UTF-8 value is limited to 64 KiB (65,536 bytes). The store preserves submitted whitespace and newlines. A `secret` entry must carry a value; empty secrets are rejected because they would surface only as a confusing downstream auth failure. `env` entries may be empty. This supports PEM keys and service-account JSON without inheriting the smaller limits of ordinary environment variables.

Reference an entry from `openclaw.json` with the `store` source:

```json5
{
  models: {
    providers: {
      openai: {
        apiKey: { source: "store", provider: "default", id: "OPENAI_API_KEY" },
      },
    },
  },
}
```

Control UI set/delete operations automatically refresh the active secrets runtime when the changed name is referenced by a `store` SecretRef in the active source config or auth-profile snapshot. Names that are not referenced skip that work. Direct CLI writes remain an offline/local path; after changing a referenced value with the CLI, run `openclaw secrets reload` so the active in-memory snapshot picks it up.

The agent can also ask you to add an entry with the [`secrets` tool](/tools/secrets): it names the entry and the reason, you type the value into a masked prompt, and the Gateway writes it directly into the store. The value never enters the chat, the transcript, or the model's context, and the same automatic runtime refresh applies.

Credential prompts are bound to the exact requesting authority and cancel when it closes. A committed answer is terminal even if the subsequent runtime refresh fails. The saved value remains; resolve the provider error and retry `openclaw secrets reload`, not the answer. Use the tool's returned full SecretRef, including its provider alias.

<Warning>
Store values are not encrypted at rest. They are stored unencrypted in the shared state SQLite database (`state/openclaw.sqlite`), protected by the same `0600` file and `0700` directory permissions as other credentials in that database. Operators who need stronger storage isolation should use an external exec provider such as the [1Password plugin](/plugins/onepassword) or [Vault SecretRefs](/plugins/vault).
</Warning>

## Secret egress proxy

The secret egress proxy lets Gateway-hosted agent subprocesses use shared-store `secret` entries without receiving their plaintext. OpenClaw puts the existing authenticated sentinel in the subprocess environment, then a Gateway-owned loopback proxy replaces it in request URLs, headers, and streamed bodies immediately before egress.

Each secret must also name the exact HTTPS hosts where substitution is allowed. Hostnames are stored lowercase in ASCII/punycode form and matched exactly; wildcards, suffix matching, and ports are not supported. A secret with no allowed hosts is never substituted. Bind a host without replacing the stored value:

```bash
openclaw secrets store set OPENAI_API_KEY --allow-host api.openai.com
```

Repeat `--allow-host` to replace the binding with multiple hosts, or use `--clear-allowed-hosts` to remove every binding. A refused request names the secret and prints the exact `store set ... --allow-host ...` command needed for that destination.

Enable it explicitly, then restart the Gateway:

```bash
openclaw config set secrets.egressProxy.enabled true --strict-json
openclaw gateway restart
```

For example, bind an OpenAI key to its API host and enable the proxy:

```bash
openclaw secrets store set OPENAI_API_KEY --allow-host api.openai.com
openclaw config set secrets.egressProxy.enabled true --strict-json
```

After restarting the Gateway, a Gateway-hosted agent can run:

```bash
curl -sS https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"
```

In the agent environment, `$OPENAI_API_KEY` is an `oc-sent-v2...end` sentinel. The proxy replaces it with the stored value only for `api.openai.com`. A request to an unbound host is refused with `Secret "OPENAI_API_KEY" is not allowed for host "<host>". Run: openclaw secrets store set OPENAI_API_KEY --allow-host <host>`.

Equivalent config:

```json5
{
  secrets: {
    egressProxy: {
      enabled: true,
      allowedHosts: ["api.openai.com"],
      bypassHosts: ["pinned-api.example.com"],
    },
  },
}
```

When enabled, OpenClaw adds these values to Gateway-hosted exec environments:

- `HTTPS_PROXY` and `HTTP_PROXY`, with per-process credentials embedded in the loopback proxy URL
- `NODE_USE_ENV_PROXY=1`, which makes supported Node.js global `fetch` clients honor `HTTP_PROXY` and `HTTPS_PROXY` without using `NODE_OPTIONS`
- `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, and `GIT_SSL_CAINFO`, pointing at the Gateway's trusted certificate bundle
- each team-store `secret` entry as an `oc-sent-v2...end` sentinel; `env` entries keep their existing behavior and precedence

Proxy authentication uses standard Basic proxy auth with username `openclaw` and a random password for each managed exec process. OpenClaw creates the grant after approval and launch checks. A background command retains its grant when the originating agent turn ends; its process supervisor owns both execution and proxy access. Base64 is not treated as encryption: the listener binds only to loopback, and a process that can read the proxy token from the agent environment can already read the sentinels in that environment. Missing, wrong, or revoked credentials receive `407 Proxy Authentication Required` and are never forwarded.

Process exit, failed startup, cancellation, and timeout revoke that process's grant and tear down its proxy connections, upstream requests, and bypass tunnels. Cancellation revokes access before native process termination. Stopping one command does not revoke a sibling command's grant. Gateway shutdown revokes every grant; restarting requires starting new commands. New grants cannot revive revoked connections or bindings. Bytes already handed to the upstream transport before revocation cannot be recalled.

Each process receives a fixed copy of the owning run's secret snapshot, including each sentinel's secret name and allowed hosts. Later commands cannot change an existing process's grant. After proxy authentication, the proxy looks up the matched sentinel in that process's registration and authorizes the normalized destination hostname before decrypting the sentinel. A sentinel that is unregistered, unresolved, unbound, or bound to another host is refused before its plaintext is forwarded.

<Warning>
Destination binding does not make an allowed host trustworthy. A bound service that reflects request credentials can still return the plaintext to the agent. DNS-level compromise can redirect a permitted hostname because policy is hostname-based, not an IP pin. Non-HTTPS requests are refused rather than protected, and HTTPS interception still has the protocol limits below. Use external network policy or process isolation when those threats are in scope.
</Warning>

The CA is generated once per Gateway start under the state directory with a ten-year certificate validity window. Its key is still process-owned, not retained for ten years. One-day leaf certificates renew on demand within their final hour without replacing the CA or interrupting established TLS connections. This keeps already-running subprocesses trusting the same issuer across renewal. Its directory is mode `0700`, its private keys are mode `0600`, it is removed during Gateway shutdown, and OpenClaw never installs it in a system trust store. Requests fail closed when a sentinel cannot be authenticated or resolved; the proxy never forwards or silently strips an unresolved sentinel. Request bodies are scanned as a stream with a bounded carry window, so substitution also works when a sentinel crosses chunk boundaries or appears in a large upload.

`openclaw status` and `openclaw doctor` report certificate preparation failures and warn when the process CA is within seven days of expiry. Failed preparation refuses the new CONNECT request with an actionable error; the next request can retry after OpenSSL, filesystem access, or clock problems are corrected. An expired or not-yet-valid CA requires checking the system clock and restarting the Gateway, not disabling TLS verification. Gateway RPC can remain reachable while protected egress is degraded. For a read-only, machine-readable probe, run `openclaw doctor --lint --only core/doctor/gateway-health --json`; the default JSON checks do not probe the running Gateway.

For an HTTP request with a valid `Content-Length` of at most 100 MiB, the proxy collects the original bytes in one process-memory buffer. It then checks current destination and sentinel bindings, substitutes in place, and sends the measured byte length upstream. This preserves fixed-length binary uploads without retaining one object per incoming chunk. Sentinel replacements cannot expand the body; no MIME type is exempt from scanning and no request-body temporary files are written.

Each proxy shares a 128 MiB reservation budget across commands, charging the declared body length plus 256 KiB of per-request headroom, with at most 64 buffered uploads being prepared or sent. This bounds staged payload and request count, not total process RSS. A busy proxy refuses additional buffered uploads with `503`; retry after in-flight requests finish. Each buffered upload has a five-minute preparation/send deadline, including upstream connection setup. Timeout, cancellation, grant revocation, and transport failure release its resources. No upstream connection is opened while collecting, and a forwarded audit records upstream send completion rather than buffer preparation.

The 100 MiB envelope is a per-request staging limit, not a destination upload-size limit. Larger requests and requests without a known length keep streaming with chunked framing and backpressure; destinations that require `Content-Length` can still reject those requests. Bytes already handed to the upstream transport cannot be recalled.

`bypassHosts` contains exact hostnames that must remain end-to-end TLS for certificate-pinned clients. Those hosts use an authenticated blind CONNECT tunnel. No substitution is possible inside the tunnel; a sentinel sent there is safe by construction because it is authenticated ciphertext rather than a credential, so the vendor sees an invalid credential and rejects it.

### Traffic allowlist

Destination binding protects secrets, not traffic: a request that carries no sentinel can reach any host once a command holds proxy credentials. Set `secrets.egressProxy.allowedHosts` to also restrict where non-sentinel traffic may go:

```bash
openclaw config set secrets.egressProxy.allowedHosts '["api.openai.com"]' --strict-json
```

When the list is present, the proxy forwards only to hostnames in the list, hosts bound to a secret registered for the requesting process, and `bypassHosts`, so an existing `--allow-host` binding keeps working without listing its host twice. A request or CONNECT tunnel to any other host is refused with `Host "<host>" is not in the secret egress proxy traffic allowlist. Add it to secrets.egressProxy.allowedHosts or bind a store secret to it with: openclaw secrets store set <NAME> --allow-host <host>, then restart the Gateway.`

An empty array is lockdown mode: only per-secret bound hosts and `bypassHosts` remain reachable. Omitting `allowedHosts` leaves traffic unrestricted. Hostnames follow the same rules as secret bindings: exact lowercase ASCII/punycode match, no wildcards or ports. Restart the Gateway after changing the allowlist.

Current limits:

- The traffic allowlist constrains only cooperating clients that honor the proxy environment (`HTTPS_PROXY` and the CA variables). A subprocess can ignore those variables and open raw sockets, so the allowlist is defense in depth; destination-bound sentinels remain the primary defense because they survive proxy bypass.
- HTTP/2 upstream connections are not supported; the proxy uses HTTP/1.1 upstream.
- WebSocket upgrades support secret substitution in the handshake URL and headers. Message frames pass through unchanged; sentinels inside WebSocket messages are not substituted.
- Non-443 HTTPS substitution is not a supported compatibility target.
- Identity-scoped secrets are not supported; only the team store participates.
- Allowed-host policy is exact-hostname authorization only. It does not validate the resolved IP or prevent an allowed origin from reflecting credentials.
- Plain HTTP is refused; it is not upgraded or substituted.
- Automatic shared-store secret egress applies only to Gateway-hosted exec. Sandbox and remote `node` exec receive neither proxy variables nor sentinels, so shared-store `secret` entries are unavailable there. Provider-native harness subprocesses also do not use this proxy. The explicit Crabbox command below grants a configured model credential separately.
- Background subprocesses retain their original secret snapshot until they exit or are stopped. Changes to stored credentials or destination bindings require a new run and a new command; stop existing commands to revoke their older grants immediately.

## Model credentials for Crabbox commands

The Crabbox plugin lets a foreground application in a Linux lease call an
OpenAI-compatible API using a credential kept on the host. Cloud agents already
keep their own inference and provider authentication on the Gateway; this command
is for API calls made by the application itself.

### Requirements

Run the command on the host that owns the configured credential, from the local
project directory that owns the lease. Use an exclusively owned,
coordinator-backed Linux lease with a configured Crabbox login and no active
egress session. The Crabbox binary must support `egress run` with
`--upstream-proxy-env`; the command checks support before reading the credential.
Use `--binary <path>` to select another binary.

The selected provider must use an API-key SecretRef in
`models.providers.<provider>.apiKey`. File, environment, exec, and shared-store
SecretRefs use the existing resolver without copying the credential into another
store. The model must resolve to an `openai-responses` or `openai-completions`
route with an HTTPS endpoint on port 443. Endpoint URLs cannot contain credentials,
a query, or a fragment. Auth-profile and OAuth credentials, custom headers,
request proxy/TLS overrides, disabled auth headers, and local-service
configuration are unsupported.

### Prepare and run

Sync files, hydrate the workspace, and install dependencies through the normal
Crabbox workflow first. The model command passes `--no-sync --no-hydrate`, so it
uses the prepared workspace and cannot fetch dependencies through its
model-host-only bridge. Keep the same local project directory for preparation
and execution: `--id` selects a lease but does not override Crabbox's repository
claim or workspace selection.

For an existing lease and configured OpenAI SecretRef, this example checks that
`curl` is available, then makes a Responses API request without reading the key:

```bash
cd ~/path/to/project
crabbox run --id <lease-id> -- curl --version
openclaw crabbox run --id <lease-id> --model openai/gpt-5.6-sol -- sh -c '
  curl --fail-with-body --silent --show-error "${OPENAI_BASE_URL%/}/responses" \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -H "Content-Type: application/json" \
    --data "{\"model\":\"$OPENAI_MODEL\",\"input\":\"Reply with OK.\"}"
'
```

Success returns the provider's response JSON. Replace `sh -c ...` with your
application command, such as `node test-app.js`. Use the endpoint appropriate to
the configured route; a Completions-only provider needs its matching API call.
`--provider <backend>` selects a Crabbox backend, while `--model` selects the
model provider. `--timeout <seconds>` bounds setup and execution together
(1–86400 seconds, default 600). Cancellation and timeout revoke credential access
immediately and give Crabbox 75 seconds for graceful cleanup.

OpenClaw resolves the selected model's configured or provider-owned API endpoint
and starts an isolated secret proxy. Crabbox's native `egress run` owns the
foreground bridge, remote command, and session cleanup. OpenClaw supplies
`OPENAI_API_KEY` as an opaque sentinel,
`OPENAI_BASE_URL`, and `OPENAI_MODEL`, plus HTTP proxy settings and a temporary
public CA bundle. The API key, upstream proxy authentication, and CA private key
stay on the host. The bridge permits only the selected hostname; this does not
block a program from opening direct sockets. Model selection sets the app's
default environment, not a limit on the provider credential's API operations or
models.

The application's HTTP client must honor both proxy and CA settings. `curl` and
Python's default `urllib.request` opener use the injected environment. For Node.js,
use a runtime supporting `NODE_USE_ENV_PROXY` (for example Node.js 24+) with
`NODE_EXTRA_CA_CERTS`. A custom Node dispatcher, Python opener, or SDK client may
override these defaults; configure its proxy and trust explicitly if needed.
Disabling certificate verification or ignoring the proxy does not establish
protected model access.

### Lifetime and recovery

Cancellation and timeout revoke credential use immediately, before command
cleanup settles. Completion closes the grant and bridge and stops the matching
lease-side egress client. The lease and prepared workspace remain available.
Keep the foreground command running for the entire app lifetime; detached apps
lose model access when it exits. Ordinary remote `exec`, `background`, and
sandbox commands do not acquire this grant.

An old binary is refused with an update message. An active-egress error requires
an idle lease or stopping an existing session you own. A repository-claim error
means you must return to the lease's owning local project directory. Do not
reclaim another job's lease to bypass either check.

If cleanup cannot confirm settlement, the command fails. Inspect
`crabbox egress status --id <lease-id>` and, when the failed command reported a
session ID, retry `crabbox egress stop --id <lease-id> --session <egress-session-id>`
for that session. Also confirm the remote workload has stopped before reusing
the lease, or release the disposable lease through its normal owner. Revocation
is not proof that an unreachable remote process has exited.

This standalone command does not require `secrets.egressProxy.enabled`, change
Gateway configuration, or restart the Gateway. After a completed or canceled
command, start a new command to obtain a fresh grant; its old sentinel and CA
files are not reusable credentials.

## File-backed API keys

Do not put `file:...` strings in the config `env` block. That block is literal and non-overriding, so `file:...` is never resolved there.

Use a file SecretRef on a supported credential field instead:

```json5
{
  secrets: {
    providers: {
      xai_key_file: {
        source: "file",
        path: "~/.openclaw/secrets/xai-api-key.txt",
        mode: "singleValue",
      },
    },
  },
  models: {
    providers: {
      xai: {
        apiKey: { source: "file", provider: "xai_key_file", id: "value" },
      },
    },
  },
}
```

For `mode: "singleValue"`, the SecretRef `id` is `"value"`. For `mode: "json"`, use an absolute JSON pointer such as `"/providers/xai/apiKey"`.

See [SecretRef Credential Surface](/reference/secretref-credential-surface) for the fields that accept SecretRefs.
