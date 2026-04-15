# Config Protection

This document describes the security hardening measures for OpenClaw gateway configuration.

## HMAC Integrity Check

The gateway computes an HMAC-SHA256 signature of the config file after every write. The signature is stored in a sidecar file (`<configPath>.sig`) alongside the config file.

### How it works

1. **On write**: After the gateway writes `openclaw.json`, it computes `HMAC-SHA256(content, gatewayToken)` and writes the hex digest to `openclaw.json.sig`.
2. **On load**: When the gateway reads `openclaw.json`, it checks whether a `.sig` file exists. If it does, the gateway recomputes the HMAC and compares it to the stored value.
3. **On mismatch**: If the HMAC does not match, the gateway logs a warning (`[security] config integrity warning: config file was modified outside the gateway process`) and sets `integrityWarning` on the config snapshot. The config is still loaded normally to avoid breaking manual editing workflows.

### Key material

The HMAC key is the gateway token stored at `~/.openclaw/gateway.token`. If no token file exists, HMAC signing and verification are skipped silently.

### Limitations

- Manual edits to the config file will trigger a mismatch warning. This is expected behavior.
- The HMAC protects integrity, not confidentiality. The config file content is not encrypted.
- If the gateway token is compromised, the HMAC can be forged.

## Scope Requirements for config.patch

The `config.patch` WebSocket method now requires the `operator.admin` scope. Clients without this scope receive an error:

```
code: INVALID_REQUEST
message: "config.patch requires operator.admin scope"
```

The `config.set` and `config.apply` methods are also classified under the `operator.admin` scope in the method scope registry.

Previously, these config-mutating methods were not explicitly classified and fell through to the default admin requirement. They are now explicitly listed in the admin scope group for clarity and auditability.

## Config Security Audit Log

Every config write and detected external modification is logged to `~/.openclaw/logs/config-audit.jsonl`. Each entry contains:

| Field          | Description                                                                |
| -------------- | -------------------------------------------------------------------------- |
| `timestamp`    | ISO 8601 timestamp of the event                                            |
| `actor`        | `"gateway"` for internal writes, `"filesystem"` for external modifications |
| `changedPaths` | List of config paths that changed                                          |
| `sourceHash`   | SHA-256 hash of the config before the change                               |
| `resultHash`   | SHA-256 hash of the config after the change                                |

This audit log is separate from the existing `config-audit.jsonl` written by `io.audit.ts`, which captures lower-level write mechanics (rename vs copy, inode metadata, etc.). The security audit log focuses on actor attribution and change tracking.

## Security Audit Integration

The `openclaw security audit` command checks for:

- **Config HMAC mismatch** (`config.hmac_integrity_mismatch`, severity: warn): Flags when the config file has been modified outside the gateway process.
- **Insecure auth toggle** (`gateway.control_ui.insecure_auth`, severity: warn): Flags when `gateway.controlUi.allowInsecureAuth` is enabled.
