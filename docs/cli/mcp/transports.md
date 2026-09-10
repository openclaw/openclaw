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

## Stdio transport

Launches a local child process and communicates over stdin/stdout.

| Field                      | Description                       |
| -------------------------- | --------------------------------- |
| `command`                  | Executable to spawn (required)    |
| `args`                     | Array of command-line arguments   |
| `env`                      | Extra environment variables       |
| `cwd` / `workingDirectory` | Working directory for the process |

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

## OAuth workflow

OAuth is for HTTP MCP servers that advertise the MCP OAuth flow. Static `Authorization` headers are ignored for a server while `auth: "oauth"` is enabled. By default, OAuth credentials are shared and operator-managed. Credentials saved by `openclaw mcp login` work with embedded MCP, CLI runners, and the local Codex app-server.

Native MCP OAuth sessions live in the owner-only shared SQLite database at `<state-dir>/state/openclaw.sqlite` (`mcp_oauth_stores`). The row can contain access and refresh tokens, dynamic client registration secrets, discovery metadata, and the temporary PKCE verifier. Refresh, login, and logout use the same SQLite lease, so parallel OpenClaw processes cannot consume one refresh token or resurrect a logged-out session.

Upgrades from the retired `<state-dir>/mcp-oauth/*.json` store are handled only by `openclaw doctor --fix`. Runtime code never reads, writes, or falls back to those files.

Until shared credentials are available, OpenClaw omits only that MCP server from the agent runtime instead of failing the agent turn. The operator, or an agent with shell access, can then run `openclaw mcp login <name>` and use the server on a later turn.

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

If `gateway.publicOrigin` is missing, the sign-in result names that setting and `openclaw doctor` reports the same operator fix. `openclaw mcp login` and `openclaw mcp logout` remain operator-only commands for shared credentials; they do not manage per-requester accounts.

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

    OpenClaw starts the registered loopback callback, prints the authorization URL, and stores temporary OAuth verifier state in shared SQLite. Approve the request in the browser and return to the terminal; token exchange completes automatically after the callback arrives.

  </Step>
  <Step title="Use the manual fallback when needed">
    If the browser runs on another machine or cannot reach the printed loopback address, copy the returned code and pass it back to OpenClaw.

    ```bash
    openclaw mcp login docs --code abc123
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

OpenClaw config uses `transport: "streamable-http"` as the canonical spelling. CLI-native MCP `type: "http"` values are accepted when saved through `openclaw mcp set` and repaired by `openclaw doctor --fix` in existing config, but `transport` is what embedded OpenClaw consumes directly.

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
