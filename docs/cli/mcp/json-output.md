---
summary: "JSON output shapes for openclaw mcp status, doctor, and probe"
title: "JSON output shapes"
read_when:
  - Scripting or building a dashboard on `openclaw mcp --json` output
  - Checking which fields `status`, `doctor`, or `probe` report
---

These are the machine-readable shapes the registry read commands emit, plus the
saved server config shape they describe.

## JSON output shapes

Use `--json` for scripts and dashboards. Field sets can grow over time, so consumers should ignore unknown keys.

Read commands report invalid config, unknown servers, and disabled named probes as `{ "ok": false, "error": { "type": "cli_error", "message": "..." } }` with a nonzero exit. Once `doctor` or `probe` produces a report, errors remain in that report rather than producing a second JSON document.

<AccordionGroup>
  <Accordion title="status --json">
    ```json
    {
      "path": "/home/user/.openclaw/openclaw.json",
      "servers": [
        {
          "name": "docs",
          "configured": true,
          "enabled": true,
          "ok": true,
          "transport": "streamable-http",
          "launch": "streamable-http https://mcp.example.com/mcp",
          "auth": "oauth",
          "authStatus": {
            "hasTokens": true,
            "requiresAuthorization": false,
            "hasClientInformation": true,
            "hasCodeVerifier": false,
            "hasDiscoveryState": true,
            "hasLastAuthorizationUrl": false,
            "state": "authorized"
          },
          "requestTimeoutMs": 20000,
          "connectionTimeoutMs": 5000,
          "toolFilter": {
            "include": ["search", "read_*"],
            "exclude": []
          },
          "supportsParallelToolCalls": true
        }
      ]
    }
    ```
  </Accordion>
  <Accordion title="doctor --json">
    ```json
    {
      "ok": true,
      "path": "/home/user/.openclaw/openclaw.json",
      "servers": [
        {
          "name": "docs",
          "ok": true,
          "issues": [
            {
              "level": "warning",
              "message": "OAuth credentials are not authorized; run openclaw mcp login docs"
            }
          ]
        }
      ]
    }
    ```

    `doctor --json` exits nonzero when any enabled checked server has an `error`-level issue. `warning` and `info` issues are reported but do not make the command fail by themselves.

  </Accordion>
  <Accordion title="probe --json">
    ```json
    {
      "generatedAt": "2026-05-31T09:00:00.000Z",
      "servers": {
        "docs": {
          "launch": "streamable-http https://mcp.example.com/mcp",
          "tools": 2,
          "codexApprovalMode": "auto",
          "approvalHint": "tools have no safety annotations; calls require approval in prompting session postures",
          "resources": true,
          "listChanged": {
            "tools": true,
            "resources": false,
            "prompts": false
          }
        }
      },
      "tools": ["docs__read_page", "docs__search"],
      "diagnostics": []
    }
    ```

    `probe --json` opens a live MCP client session and prints its result directly; unlike `status`/`doctor`, the output has no top-level `path` field. Each server includes its effective `codexApprovalMode`; `approvalHint` appears when that mode is `auto` and the discovered tools have no safety annotations. The hint describes approval requirements under prompting postures, not the default full-permission posture. `resources` and `prompts` keys are present only when the server actually advertises that capability (a server without prompts omits the `prompts` key rather than reporting `false`). The command prints the complete result before exiting nonzero when diagnostics are present or a selected enabled server did not connect, so automation can inspect partial successes. Use `probe` for reachability and capability proof, not for static config audits.

  </Accordion>
</AccordionGroup>

Example config shape:

```json
{
  "mcp": {
    "servers": {
      "context7": {
        "command": "uvx",
        "args": ["context7-mcp"]
      },
      "docs": {
        "url": "https://mcp.example.com",
        "transport": "streamable-http",
        "requestTimeoutMs": 20000,
        "connectionTimeoutMs": 5000,
        "supportsParallelToolCalls": true,
        "auth": "oauth",
        "oauth": {
          "scope": "docs.read"
        },
        "sslVerify": true,
        "clientCert": "/path/to/client.crt",
        "clientKey": "/path/to/client.key",
        "toolFilter": {
          "include": ["search_*"],
          "exclude": ["admin_*"]
        },
        "codex": {
          "defaultToolsApprovalMode": "approve"
        }
      }
    }
  }
}
```
