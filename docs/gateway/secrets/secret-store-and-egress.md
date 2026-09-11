---
summary: "The shared secret store, the default-off secret egress proxy, and file-backed API keys"
read_when:
  - Storing team-wide secrets and environment values in the shared secret store
  - Enabling the destination-bound secret egress proxy or its traffic allowlist
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

- `HTTPS_PROXY` and `HTTP_PROXY`, with per-run credentials embedded in the loopback proxy URL
- `NODE_USE_ENV_PROXY=1`, which makes supported Node.js global `fetch` clients honor `HTTP_PROXY` and `HTTPS_PROXY` without using `NODE_OPTIONS`
- `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, and `REQUESTS_CA_BUNDLE`, pointing at the ephemeral CA certificate
- each team-store `secret` entry as an `oc-sent-v2...end` sentinel; `env` entries keep their existing behavior and precedence

Proxy authentication uses standard Basic proxy auth with username `openclaw` and a random per-run password. The token expires when the exact agent run closes, including cancellation and replacement. Base64 is not treated as encryption: the listener binds only to loopback, and a process that can read the proxy token from the agent environment can already read the sentinels in that environment. Missing, wrong, or expired credentials receive `407 Proxy Authentication Required` and are never forwarded.

Run closure also tears down existing proxy connections, upstream requests, and bypass tunnels. Reusing the run id or registering a new token cannot revive the old connections or bindings. Bytes already handed to the upstream transport before closure cannot be recalled.

The run snapshot registers each sentinel together with its secret name and allowed hosts. After proxy authentication, the proxy looks up the matched sentinel in that run's registration and authorizes the normalized destination hostname before decrypting the sentinel. A sentinel that is unregistered, unresolved, unbound, or bound to another host is refused before its plaintext is forwarded.

<Warning>
Destination binding does not make an allowed host trustworthy. A bound service that reflects request credentials can still return the plaintext to the agent. DNS-level compromise can redirect a permitted hostname because policy is hostname-based, not an IP pin. Non-HTTPS requests are refused rather than protected, and HTTPS interception still has the protocol limits below. Use external network policy or process isolation when those threats are in scope.
</Warning>

The CA is generated once per Gateway start under the state directory with a ten-year certificate validity window. Its key is still process-owned, not retained for ten years. One-day leaf certificates renew on demand within their final hour without replacing the CA or interrupting established TLS connections. This keeps already-running subprocesses trusting the same issuer across renewal. Its directory is mode `0700`, its private keys are mode `0600`, it is removed during Gateway shutdown, and OpenClaw never installs it in a system trust store. Requests fail closed when a sentinel cannot be authenticated or resolved; the proxy never forwards or silently strips an unresolved sentinel. Request bodies are scanned as a stream with a bounded carry window, so substitution also works when a sentinel crosses chunk boundaries or appears in a large upload.

`openclaw status` and `openclaw doctor` report certificate preparation failures and warn when the process CA is within seven days of expiry. Failed preparation refuses the new CONNECT request with an actionable error; the next request can retry after OpenSSL, filesystem access, or clock problems are corrected. An expired or not-yet-valid CA requires checking the system clock and restarting the Gateway, not disabling TLS verification. Gateway RPC can remain reachable while protected egress is degraded. For a read-only, machine-readable probe, run `openclaw doctor --lint --only core/doctor/gateway-health --json`; the default JSON checks do not probe the running Gateway.

`bypassHosts` contains exact hostnames that must remain end-to-end TLS for certificate-pinned clients. Those hosts use an authenticated blind CONNECT tunnel. No substitution is possible inside the tunnel; a sentinel sent there is safe by construction because it is authenticated ciphertext rather than a credential, so the vendor sees an invalid credential and rejects it.

### Traffic allowlist

Destination binding protects secrets, not traffic: a request that carries no sentinel can reach any host once a run holds proxy credentials. Set `secrets.egressProxy.allowedHosts` to also restrict where non-sentinel traffic may go:

```bash
openclaw config set secrets.egressProxy.allowedHosts '["api.openai.com"]' --strict-json
```

When the list is present, the proxy forwards only to hostnames in the list, hosts bound to a secret registered for the current agent run, and `bypassHosts`, so an existing `--allow-host` binding keeps working without listing its host twice. A request or CONNECT tunnel to any other host is refused with `Host "<host>" is not in the secret egress proxy traffic allowlist. Add it to secrets.egressProxy.allowedHosts or bind a store secret to it with: openclaw secrets store set <NAME> --allow-host <host>, then restart the Gateway.`

An empty array is lockdown mode: only per-secret bound hosts and `bypassHosts` remain reachable. Omitting `allowedHosts` leaves traffic unrestricted. Hostnames follow the same rules as secret bindings: exact lowercase ASCII/punycode match, no wildcards or ports. Restart the Gateway after changing the allowlist.

Current limits:

- The traffic allowlist constrains only cooperating clients that honor the proxy environment (`HTTPS_PROXY` and the CA variables). A subprocess can ignore those variables and open raw sockets, so the allowlist is defense in depth; destination-bound sentinels remain the primary defense because they survive proxy bypass.
- HTTP/2 upstream connections are not supported; the proxy uses HTTP/1.1 upstream.
- WebSocket upgrades support secret substitution in the handshake URL and headers. Message frames pass through unchanged; sentinels inside WebSocket messages are not substituted.
- Non-443 HTTPS substitution is not a supported compatibility target.
- Identity-scoped secrets are not supported; only the team store participates.
- Allowed-host policy is exact-hostname authorization only. It does not validate the resolved IP or prevent an allowed origin from reflecting credentials.
- Plain HTTP is refused; it is not upgraded or substituted.
- Secret egress applies only to Gateway-hosted exec. Sandbox and remote `node` exec receive neither proxy variables nor sentinels, so shared-store `secret` entries are unavailable there. Provider-native harness subprocesses also do not use this proxy.
- Background subprocesses lose proxy authorization when their owning agent run ends, even if the process itself is still alive.

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
