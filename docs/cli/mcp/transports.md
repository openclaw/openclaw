---
summary: "Stdio, SSE/HTTP, and Streamable HTTP transport fields plus the MCP OAuth workflow"
title: "Transports and OAuth"
read_when:
  - Choosing a transport for a saved MCP server
  - Looking up a transport config field
  - Running or repairing the MCP OAuth login flow
---

These are the transport shapes a saved MCP server definition can use, and the
OAuth workflow that HTTP transports can authenticate with.

When Codex owns the MCP connection, explicit `connectionTimeoutMs` values control
startup, including initialization and initial tool discovery, and
`requestTimeoutMs` values control tool calls. OpenClaw preserves millisecond
precision when converting these values to Codex's seconds-based settings; unset
values keep Codex's defaults. The `supportsParallelToolCalls` hint is also
forwarded. Codex can additionally run tools with a `readOnlyHint` annotation in
parallel.

## Stdio transport

Launches a local child process and communicates over stdin/stdout.

| Field                      | Description                       |
| -------------------------- | --------------------------------- |
| `command`                  | Executable to spawn (required)    |
| `args`                     | Array of command-line arguments   |
| `env`                      | Extra environment variables       |
| `cwd` / `workingDirectory` | Working directory for the process |

Shutdown can force a slow anchor and relay to exit after their control, output,
and lineage pipes close. A still-live anchor is killed and reaped through its
relay. If the anchor group is already gone, the host can kill an unresponsive
relay directly. The host then confirms actual exit and group disappearance. Confirmed cleanup
completes normally; a later connection starts a fresh server. Unconfirmed cleanup still reports an error with the missing
closure facts, elapsed time, and any failed signal delivery. The cleanup deadline
does not change when shutdown escalates.

For a supported `docker run` command, OpenClaw assigns container ownership labels
and a temporary Docker CID file. Closing the connection sends the container's
configured stop signal with the existing two-second stdio grace, then removes
that exact container through the same Docker daemon, including when initialization
times out. On Gateway startup, OpenClaw also reclaims labeled containers from a previous
Gateway whose process is proven to have exited. Containers without this state
directory's ownership label are left alone; an unavailable daemon or an unknown
process identity produces a warning and preserves the container.

Connection deadlines stay unchanged. If Docker is still creating a container,
cleanup retains its client and exclusive state ownership until Docker reports
the container ID or the client exits. A warning identifies pending cleanup.
Unconfirmed removal also retains state ownership; inspect Docker and restart the
owning OpenClaw process before retrying.

This also supports a single literal `sh -c 'exec docker run ...'` wrapper.
Shell expansions, pipelines, additional commands, unknown Docker options, existing
CID files, and `openclaw.mcp.*` label conflicts disable automatic container custody
and produce a warning. The original command still runs. Use a direct `docker run`
argument array for predictable cleanup. Recovery inspects only Docker daemons
referenced by the current enabled MCP configuration, so retain the server definition
until any containers from an interrupted Gateway have been reclaimed.

<Warning>
**Stdio env safety filter**

OpenClaw rejects interpreter-startup, loader-hijack, and shell-init env keys before spawning a stdio MCP server, even if they appear in a server's `env` block. This uses the same host environment security policy as other OpenClaw-spawned processes: it blocks known interpreter startup hooks (for example `NODE_OPTIONS`, `PYTHONSTARTUP`, `PERL5OPT`, `RUBYOPT`, `BASHOPTS`, `KSH_ENV`), shared-library and function-injection prefixes (`DYLD_*`, `LD_*`, `BASH_FUNC_*`), and similar runtime-control variables. Startup drops these silently and logs a warning so they cannot inject an implicit prelude, swap the interpreter, enable a debugger, or hijack the dynamic linker against the stdio process. An explicit allowlist keeps ordinary MCP credential env vars usable (`GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `DATABASE_URL`, `MONGODB_URI`, `REDIS_URL`, `AMQP_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`), along with ordinary proxy and server-specific env vars (`HTTP_PROXY`, custom `*_API_KEY`, etc.). Other `AWS_*` keys such as `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` remain blocked because they point at credential files rather than carry a credential value directly.

If your MCP server genuinely needs one of the blocked variables, set it on the gateway host process instead of under the stdio server's `env`.
</Warning>

## SSE / HTTP transport

Connects to a remote MCP server over HTTP Server-Sent Events.

| Field                       | Description                                                      |
| --------------------------- | ---------------------------------------------------------------- |
| `url`                       | HTTP or HTTPS URL of the remote server (required)                |
| `headers`                   | Optional key-value map of HTTP headers (for example auth tokens) |
| `connectionTimeoutMs`       | Per-server connection timeout in ms (optional)                   |
| `requestTimeoutMs`          | Per-server MCP request timeout in milliseconds                   |
| `auth: "oauth"`             | Use MCP OAuth credentials saved by `openclaw mcp login`          |
| `sslVerify`                 | Set false only for explicitly trusted private HTTPS endpoints    |
| `clientCert` / `clientKey`  | mTLS client certificate and key paths                            |
| `supportsParallelToolCalls` | Hint that concurrent calls are safe for this server              |

Example:

```json
{
  "mcp": {
    "servers": {
      "remote-tools": {
        "url": "https://mcp.example.com",
        "auth": "oauth",
        "requestTimeoutMs": 20000,
        "headers": {
          "Authorization": "Bearer <token>"
        }
      }
    }
  }
}
```

Sensitive values in `url` (userinfo) and `headers` are redacted in logs and status output. `openclaw mcp doctor` warns when sensitive-looking `headers` or `env` entries contain literal values, so operators can move those values out of committed config.

Doctor checks the authored values, including values from `$include` files, before environment substitution. References such as `${MCP_TOKEN}` and `Bearer ${MCP_TOKEN}` do not trigger the literal-value warning when the variable is set. Nonempty literal fallbacks such as `${MCP_TOKEN:-literal-token}`, escaped placeholders, and literal text around references still warn; `Bearer` and `Basic` auth scheme prefixes are allowed. Connection probes still use the resolved values.

If a legacy SSE message endpoint returns HTTP 404, or a stateful Streamable HTTP
session expires, OpenClaw retires that connection and reconnects on the next
discovery. The failed call is reported without replaying it, because a tool may
have already changed state before the connection failed.

## OAuth workflow

OAuth is for HTTP MCP servers that advertise the MCP OAuth flow. Static `Authorization` headers are ignored for a server while `auth: "oauth"` is enabled. By default, OAuth credentials are shared and operator-managed. Credentials saved by `openclaw mcp login` work with embedded MCP, CLI runners, and the local Codex app-server.

Native MCP OAuth sessions live in the owner-only shared SQLite database at `<state-dir>/state/openclaw.sqlite` (`mcp_oauth_stores`). The row can contain access and refresh tokens, dynamic client registration secrets, discovery metadata, and the temporary PKCE verifier. A [pre-registered client secret](#pre-registered-oauth-clients) is never written to this row. Refresh, login, and logout use the same SQLite lease, so parallel OpenClaw processes cannot consume one refresh token or resurrect a logged-out session.

Upgrades from the retired `<state-dir>/mcp-oauth/*.json` store are handled only by `openclaw doctor --fix`. Runtime code never reads, writes, or falls back to those files.

Until shared credentials are available, OpenClaw withholds that server's account tools instead of failing the agent turn. The owner can ask the agent to connect in a direct chat and receive a sign-in link in the same turn, or run `openclaw mcp login <name>` while the Gateway runs. After approval, send another message to use the server; no Gateway restart is needed. Shared sign-in links are not posted in group chats.

If a server rejects a token with `insufficient_scope`, OpenClaw preserves the requested scope and asks for `openclaw mcp login <name>` instead of repeating a refresh that cannot grant new scope. That login starts a new authorization request while keeping the previous token until replacement credentials are saved.

When a remote MCP service is already backed by a separate OpenClaw refresh-capable auth profile, you can optionally set `oauth.authProfileId`. OpenClaw refreshes either credential source before runtime projection and passes only the current access token to the downstream MCP client.

Set `oauth.identity: "per-requester"` when every authenticated sender should connect a separate account. Per-requester OAuth requires an HTTP server URL and cannot use `oauth.authProfileId`. Configure `gateway.publicOrigin` as the externally reachable HTTPS origin of the Gateway; HTTP is accepted only for literal loopback hosts (`localhost`, `127.0.0.1`, or `[::1]`) during local development. The provider redirects to `<gateway.publicOrigin>/oauth/mcp/callback` after authorization.

```json5
{
  gateway: {
    publicOrigin: "https://gateway.example.com",
  },
  mcp: {
    servers: {
      docs: {
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        auth: "oauth",
        oauth: {
          identity: "per-requester",
          scope: "docs.read",
        },
      },
    },
  },
}
```

The per-requester flow is sender-driven:

1. The sender calls a tool from the server before connecting an account.
2. OpenClaw returns a sign-in link for that sender instead of exposing another sender's credentials.
3. The provider redirects through the Gateway callback. After the callback succeeds, the sender retries the tool call with their connected account.

For per-requester accounts, missing `gateway.publicOrigin` is reported by the sign-in result and `openclaw doctor`. Shared operator sign-in instead falls back to the Gateway's loopback address. `openclaw mcp login` and `openclaw mcp logout` manage only shared credentials, not per-requester accounts.

Sign-in links are single-use bearer links: any chat participant who opens one connects their own account to the sender the link was issued for. Use per-requester OAuth in channels where every trusted sender is mutually trusted; a requester-private sign-in handoff is tracked as follow-up work.

The shared operator flow uses the following commands:

<Steps>
  <Step title="Save the server">
    Add or update the server with `auth: "oauth"` and any optional OAuth metadata.

    ```bash
    openclaw mcp set docs '{"url":"https://mcp.example.com/mcp","transport":"streamable-http","auth":"oauth","oauth":{"scope":"docs.read"}}'
    ```

    For an auth-profile-backed bearer, save the profile binding:

    ```bash
    openclaw mcp set docs '{"url":"https://mcp.example.com/mcp","transport":"streamable-http","auth":"oauth","oauth":{"authProfileId":"docs:mcp"}}'
    ```

  </Step>
  <Step title="Start login">
    Run login to create the authorization request.

    ```bash
    openclaw mcp login docs
    ```

    With the Gateway running, login asks that Gateway to create the sign-in link and prints it. The provider redirects to `<gateway.publicOrigin>/oauth/mcp/callback`, or to `http://127.0.0.1:<gateway-port>/oauth/mcp/callback` without a public origin. Approve the request until the page says **You're connected.** The Gateway saves credentials in shared SQLite and the next agent turn can use them.

    With the Gateway stopped, login keeps its local loopback flow: it starts a callback listener and waits for the browser to return. Offline login resolves configured `mcp.servers`; the running Gateway can also resolve plugin-declared servers.

    Providers may register an HTTP loopback callback without a port, as allowed by RFC 8252. OpenClaw retains that registration for the same `127.0.0.1`, `[::1]`, or `localhost` callback while sending the listener's port in authorization and token requests. Other callback components must match; non-loopback callbacks still require an exact match.

  </Step>
  <Step title="Use the manual fallback when needed">
    With a running Gateway, if the browser is on another device and cannot load the loopback callback, copy the complete failed redirect address. Paste it into the direct chat that started sign-in, or pass it to the CLI:

    ```bash
    openclaw mcp login docs --callback-url 'http://127.0.0.1:18789/oauth/mcp/callback?code=abc123&state=<state>'
    ```

    Keep the entire URL, including `state` and any `iss` value. The code is single-use and bound to the original state and PKCE verifier.

    For an offline CLI attempt only, use the returned code with `--code`. If the redirect includes `iss`, pass its exact decoded value with `--issuer`:

    ```bash
    openclaw mcp login docs --code abc123 --issuer https://accounts.example.com
    ```

  </Step>
  <Step title="Check authorization">
    Use status or doctor to confirm that tokens are present and do not require additional authorization. If status reports `authorization-required` or doctor asks for additional authorization, run `openclaw mcp login <name>` again.

    ```bash
    openclaw mcp status --verbose
    openclaw mcp doctor docs --probe
    ```

  </Step>
  <Step title="Clear credentials">
    Logout removes stored OAuth credentials but keeps the saved server definition.

    ```bash
    openclaw mcp logout docs
    ```

  </Step>
</Steps>

If the provider rotates tokens or the authorization state gets stuck, run `openclaw mcp logout <name>`, then repeat `login`. `logout` can clear credentials for a saved HTTP server even after `auth: "oauth"` has been removed from config, as long as the server name and URL still identify the credential store entry.

### Pre-registered OAuth clients

Some providers do not offer dynamic client registration and require an OAuth app that you register yourself. Others offer registration but you want a client with the least access. Set `oauth.clientId` to that app's client ID. OpenClaw then always signs in with it and never runs dynamic client registration or client ID metadata documents, even when the server advertises a registration endpoint.

- `oauth.clientId` requires `auth: "oauth"`. It cannot be combined with `oauth.clientMetadataUrl` or `oauth.authProfileId`, and it is not yet supported with `oauth.identity: "per-requester"`.
- `oauth.clientSecret` is optional and accepts only a SecretRef (`env`, `file`, `exec`, or `store`). Plaintext strings are rejected. There is no CLI flag for it, so the secret never appears in process arguments. Set it with:

  ```bash
  openclaw config set mcp.servers.docs.oauth.clientSecret \
    --ref-source env --ref-provider default --ref-id DOCS_MCP_CLIENT_SECRET
  ```

  A running Gateway resolves the reference with its other secrets; after changing it, run `openclaw secrets reload`. With the Gateway stopped, `openclaw mcp login` and `openclaw mcp probe` resolve it in that terminal, so the variable must be set there. If the reference cannot be resolved, sign-in stops with an error that names the config path and the reference, never the value. `openclaw mcp probe` reports that error as the server's diagnostic, still checks the other servers, and exits nonzero.

- OpenClaw sends the secret only to the provider's token endpoint, for both the code exchange and every refresh. It picks `client_secret_basic`, `client_secret_post`, or no client authentication from the provider's advertised `token_endpoint_auth_methods_supported`. The secret is not stored in the SQLite sign-in row, the sign-in URL, logs, or `openclaw mcp status --json`. PKCE (`S256`) stays on for every sign-in. For an app on your own machine, the client secret is a configuration value, not a security boundary.
- Saved tokens belong to the client that obtained them. When `oauth.clientId` changes, existing tokens stop being used, `openclaw mcp status` reports `requires-authorization`, and an owner's direct chat offers the server's connect tool again. `openclaw mcp login <name>` signs in again with the new client.

Register the exact callback URL that your sign-in uses. Providers often compare it byte for byte, so OpenClaw never retries with another loopback host for a pre-registered client:

| Sign-in path                                                         | Callback to register                                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `openclaw mcp login` or a chat sign-in link with the Gateway running | `<gateway.publicOrigin>/oauth/mcp/callback`, or `http://127.0.0.1:<gateway-port>/oauth/mcp/callback` without a public origin |
| **Settings → MCP** in the Control UI                                 | `<Control UI origin>/oauth/provider/callback`                                                                                |
| `openclaw mcp login` with the Gateway stopped                        | `oauth.redirectUrl`, or `http://127.0.0.1:8989/oauth/callback` when it is not set                                            |

If `oauth.redirectUrl` is set and differs from the callback a Gateway sign-in uses, that sign-in fails before contacting the provider and names both URLs. Register the Gateway callback and remove `oauth.redirectUrl` (or set it to that URL), or sign in from the terminal with the Gateway stopped.

`oauth.authorizationParams` adds parameters to the sign-in URL. Only `access_type`, `prompt`, and `login_hint` are accepted; protocol parameters such as `redirect_uri`, `state`, and the PKCE challenge stay under OpenClaw's control. It works with or without `oauth.clientId`.

For example, Google issues a refresh token only when the sign-in asks for offline access and consent. Without them, the sign-in expires after about an hour:

```json5
{
  mcp: {
    servers: {
      workspace: {
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        auth: "oauth",
        oauth: {
          clientId: "1234567890-example.apps.googleusercontent.com",
          clientSecret: { source: "env", provider: "default", id: "GOOGLE_MCP_CLIENT_SECRET" },
          scope: "openid email",
          authorizationParams: { access_type: "offline", prompt: "consent" },
        },
      },
    },
  },
}
```

Then add the matching callback from the table to the OAuth client's authorized redirect URIs and run `openclaw mcp login workspace`.

## Streamable HTTP transport

`streamable-http` is an additional transport option alongside `sse` and `stdio`. It uses HTTP streaming for bidirectional communication with remote MCP servers.

| Field                       | Description                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `url`                       | HTTP or HTTPS URL of the remote server (required)                                      |
| `transport`                 | Set to `"streamable-http"` to select this transport; when omitted, OpenClaw uses `sse` |
| `headers`                   | Optional key-value map of HTTP headers (for example auth tokens)                       |
| `connectionTimeoutMs`       | Per-server connection timeout in ms (optional)                                         |
| `requestTimeoutMs`          | Per-server MCP request timeout in milliseconds                                         |
| `auth: "oauth"`             | Use MCP OAuth credentials saved by `openclaw mcp login`                                |
| `sslVerify`                 | Set false only for explicitly trusted private HTTPS endpoints                          |
| `clientCert` / `clientKey`  | mTLS client certificate and key paths                                                  |
| `supportsParallelToolCalls` | Hint that concurrent calls are safe for this server                                    |

OpenClaw config uses `transport: "streamable-http"` as the current spelling. CLI-native MCP `type: "http"` values are accepted when saved through `openclaw mcp set` and repaired by `openclaw doctor --fix` in existing config, but `transport` is what embedded OpenClaw consumes directly.

Example:

```json
{
  "mcp": {
    "servers": {
      "streaming-tools": {
        "url": "https://mcp.example.com/stream",
        "transport": "streamable-http",
        "connectionTimeoutMs": 10000,
        "requestTimeoutMs": 30000,
        "headers": {
          "Authorization": "Bearer <token>"
        }
      }
    }
  }
}
```

<Note>
Registry commands do not start the channel bridge. Only `probe` and `doctor --probe` open a live MCP client session to prove the target server is reachable.
</Note>
