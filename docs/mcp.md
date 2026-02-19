# MCP (Model Context Protocol) Support

OpenClaw supports native MCP client integration, allowing you to connect any MCP-compatible server and expose its tools alongside OpenClaw's built-in tools — no custom skills needed.

## Quick Start

Add an `mcp` section to your `openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "mcp": {
        "servers": {
          "filesystem": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"]
          }
        }
      }
    }
  }
}
```

Restart the gateway. The filesystem server's tools will appear as `mcp_filesystem_*` in your agent's tool list.

---

## Configuration Reference

### Server Config (`mcp.servers.<name>`)

| Field            | Type                             | Default    | Description                                       |
| ---------------- | -------------------------------- | ---------- | ------------------------------------------------- |
| `enabled`        | boolean                          | `true`     | Enable/disable this server                        |
| `transport`      | `"stdio"` \| `"sse"` \| `"http"` | `"stdio"`  | Transport type                                    |
| `command`        | string                           | —          | Executable (required for stdio)                   |
| `args`           | string[]                         | `[]`       | Command arguments                                 |
| `env`            | Record<string, string>           | `{}`       | Environment variables (supports `secret://` URIs) |
| `cwd`            | string                           | —          | Working directory for child process               |
| `url`            | string                           | —          | Server URL (required for sse/http)                |
| `headers`        | Record<string, string>           | `{}`       | HTTP headers (supports `secret://` URIs)          |
| `timeout`        | number                           | `30000`    | Connection timeout (ms)                           |
| `toolTimeout`    | number                           | `60000`    | Per-tool-call timeout (ms)                        |
| `restartOnCrash` | boolean                          | `true`     | Auto-restart crashed stdio servers                |
| `maxRestarts`    | number                           | `5`        | Max restart attempts before giving up             |
| `toolPrefix`     | string                           | server key | Custom prefix for tool names                      |
| `resources`      | boolean                          | `true`     | Enable resource discovery                         |
| `resourceFilter` | string[]                         | `[]`       | Filter resources by URI pattern (empty = all)     |

---

## Transport Examples

### Stdio (Local Process)

Most MCP servers use stdio — OpenClaw spawns them as child processes:

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"]
      }
    }
  }
}
```

Python servers work too:

```json
{
  "mcp": {
    "servers": {
      "my-tools": {
        "command": "python",
        "args": ["-m", "my_mcp_server"],
        "env": {
          "API_KEY": "secret://env/MY_API_KEY"
        }
      }
    }
  }
}
```

Or via `uvx` for Python packages:

```json
{
  "mcp": {
    "servers": {
      "github": {
        "command": "uvx",
        "args": ["mcp-server-github"],
        "env": {
          "GITHUB_TOKEN": "secret://env/GITHUB_TOKEN"
        }
      }
    }
  }
}
```

### SSE (Server-Sent Events)

For remote MCP servers that expose an SSE endpoint:

```json
{
  "mcp": {
    "servers": {
      "remote-tools": {
        "transport": "sse",
        "url": "https://mcp.example.com/sse",
        "headers": {
          "Authorization": "secret://env/MCP_AUTH_TOKEN"
        }
      }
    }
  }
}
```

### Streamable HTTP

For MCP servers using the newer streamable HTTP transport:

```json
{
  "mcp": {
    "servers": {
      "api-tools": {
        "transport": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": {
          "X-API-Key": "secret://gcp/mcp-api-key"
        }
      }
    }
  }
}
```

---

## Secret Management (`secret://` URIs)

Never put credentials in plaintext config. Use `secret://` URIs in `env` and `headers` fields:

| URI Pattern                        | Source                                |
| ---------------------------------- | ------------------------------------- |
| `secret://env/VAR_NAME`            | Environment variable                  |
| `secret://gcp/SECRET_NAME`         | Google Cloud Secret Manager           |
| `secret://gcp/SECRET_NAME#version` | GCP Secret Manager (specific version) |
| `secret://aws/SECRET_NAME`         | AWS Secrets Manager                   |
| `secret://vault/path/to/secret`    | HashiCorp Vault                       |

```json
{
  "env": {
    "API_KEY": "secret://env/MY_API_KEY",
    "GCP_SECRET": "secret://gcp/my-secret",
    "AWS_SECRET": "secret://aws/my-secret"
  }
}
```

Secrets are resolved at server start time, kept only in memory, and never logged.

> **Warning:** If you use plaintext values for keys named `PASSWORD`, `SECRET`, `TOKEN`, etc., OpenClaw will log a warning suggesting you use `secret://` URIs instead.

---

## Tool Naming

MCP tools are namespaced to avoid collisions with native tools:

```
mcp_{serverName}_{toolName}
```

For example, a server named `filesystem` with a tool `read_file` becomes `mcp_filesystem_read_file`.

Override the prefix with `toolPrefix`:

```json
{
  "mcp": {
    "servers": {
      "my-fs": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        "toolPrefix": "fs"
      }
    }
  }
}
```

This produces `mcp_fs_read_file` instead of `mcp_my-fs_read_file`.

### Tool Policy

MCP tools work with the existing tool policy system:

```json
{
  "gateway": {
    "tools": {
      "allow": ["mcp_github_*"],
      "deny": ["mcp_filesystem_write_file"]
    }
  }
}
```

---

## Resource Injection

MCP servers can expose **resources** (read-only data like files, database records, API state). When enabled, resources are automatically injected into the agent's context as external data.

Resources are wrapped with security markers and clearly labeled as external content.

To disable resource injection for a specific server:

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "command": "my-mcp-server",
        "resources": false
      }
    }
  }
}
```

To filter specific resources:

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "command": "my-mcp-server",
        "resourceFilter": ["file:///important/", "db://users"]
      }
    }
  }
}
```

---

## Security

All MCP server output is treated as **untrusted external content** — the same security model used for `web_fetch` results:

1. **Pattern detection** — Suspicious patterns (prompt injection attempts) are logged as warnings
2. **Marker sanitization** — Content cannot escape security boundary markers
3. **Untrusted wrapping** — All output wrapped with `EXTERNAL_UNTRUSTED_CONTENT` markers
4. **Process isolation** — Stdio servers run as child processes with no access to OpenClaw internals

---

## Per-Agent Configuration

MCP can be configured at the defaults level (all agents) or per-agent:

```json
{
  "agents": {
    "defaults": {
      "mcp": {
        "servers": {
          "filesystem": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/shared"]
          }
        }
      }
    },
    "list": [
      {
        "name": "dev-agent",
        "mcp": {
          "servers": {
            "github": {
              "command": "uvx",
              "args": ["mcp-server-github"],
              "env": { "GITHUB_TOKEN": "secret://env/GITHUB_TOKEN" }
            }
          }
        }
      }
    ]
  }
}
```

---

## Troubleshooting

### Server won't start

- Check that the `command` is installed and on PATH
- For `npx` servers, ensure Node.js is available
- For `uvx` servers, ensure Python and uv are installed
- Check logs for "MCP server 'X' failed to start" messages

### Tools not appearing

- Verify the server is `enabled` (default: `true`)
- Check `gateway.tools.allow` / `deny` isn't filtering them out
- Look for the server in status: tools are only exposed from servers in `ready` state

### Server keeps crashing

- Check stderr output in logs (logged at warn level)
- Increase `timeout` if the server takes long to initialize
- Set `maxRestarts: 0` to disable auto-restart for debugging
- Check environment variables are set correctly

### Secret resolution failures

- `secret://env/X` — ensure the variable is set in the gateway's environment
- `secret://gcp/X` — ensure GCP credentials are configured (`gcloud auth` or service account)
- Failed secret resolution prevents the server from starting (fail-closed)

### Timeouts

- `timeout` controls connection timeout (default 30s)
- `toolTimeout` controls per-call timeout (default 60s)
- Increase these for slow servers or network latency
