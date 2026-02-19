---
summary: "Enterprise deployment: ConsentGate, exec approvals, gateway bind, channels, and logging"
read_when:
  - Deploying OpenClaw for teams or compliance
  - Configuring ConsentGuard, audit, and exec approvals
title: "Enterprise configuration"
---

# Enterprise configuration

This page shows the **correct OpenClaw config shape** for enterprise deployment: ConsentGate (ConsentGuard), exec approvals, gateway bind and Tailscale, channel integrations, and audit-friendly logging. Use it as a reference; merge the snippets into your existing `~/.openclaw/openclaw.json` (or `openclaw.json5`).

<Warning>
Do **not** copy generic "enterprise" blocks that use wrong key names. OpenClaw uses `gateway.consentGate`, `gateway.port` and `gateway.bind` (not a `gateway.bind.host` object), and **all channels under `channels.*`** (e.g. `channels.msteams`, not top-level `msteams`). The examples below match the real schema.
</Warning>

## ConsentGate (ConsentGuard)

When enabled, gated tools require a valid consent token before execution. Use **observe-only** first, then set `observeOnly: false` for enforce mode.

```json5
{
  gateway: {
    consentGate: {
      enabled: true,
      observeOnly: false, // enforce mode; use true for safe rollout
      storagePath: "~/.openclaw/consentgate",
      trustTierDefault: "T0",
      trustTierMapping: { "telegram:": "T0", "discord:": "T1" },
      gatedTools: [
        "exec",
        "write",
        "gateway",
        "sessions_spawn",
        "sessions_send",
        "whatsapp_login",
        "skills.install",
        "system.run",
      ],
      provider: "native", // optional; "external" reserved for future
      audit: {
        enabled: true,
        destination: "stdout", // or a file path for SIEM
        redactSecrets: true,
      },
    },
  },
}
```

- **Trust tiers:** Map session key prefixes to tiers via `trustTierMapping`; use `trustTierDefault` when no mapping matches. Optionally restrict which tools each tier can use via `tierToolMatrix`.
- **Audit:** When `audit.enabled` is true and `audit.destination` is set, every consent decision is written as JSONL to stdout or the given file path (with optional redaction). See [ConsentGate operator runbook](/reference/consentgate-operator-runbook) and [Security](/gateway/security).

## Gateway bind and Tailscale

- **Bind:** Use `gateway.port` (e.g. `3000`) and `gateway.bind`. For LAN exposure use `gateway.bind: "lan"`; for local-only use `"loopback"` (default).
- **Tailscale:** Use `gateway.tailscale.mode: "serve"` or `"funnel"` to expose the Control UI; optional `gateway.tailscale.hostname` for a stable hostname (e.g. `openclaw-enterprise-gateway`).
- **Trusted proxies:** When behind a reverse proxy, set `gateway.trustedProxies` to the proxy IPs.

```json5
{
  gateway: {
    port: 18789,
    bind: "lan",
    trustedProxies: ["127.0.0.1"],
    tailscale: {
      mode: "serve",
      hostname: "openclaw-enterprise-gateway",
    },
  },
}
```

## Exec approvals

Exec approval behavior is **not** controlled by the main config file. It is configured via:

- **Control UI:** Settings → Exec approvals (gateway or per-node).
- **File:** `~/.openclaw/exec-approvals.json` (see [exec-approvals](/reference/exec-approvals) for schema).
- **CLI:** `openclaw exec-approvals` to view or edit.

Default approval timeout is 120 seconds. Allowlist entries (command + optional args) let low-risk commands bypass approval. Document this file and the UI path for operators; there is no top-level `execApprovals` block in the config schema.

## Channels (correct keys)

All channel config lives under **`channels.*`**. Use env vars for secrets (e.g. in credentials or config).

- **Microsoft Teams:** [channels/msteams](/channels/msteams) — `channels.msteams`
- **Google Chat:** [channels/googlechat](/channels/googlechat) — `channels.googlechat`
- **Slack:** [channels/slack](/channels/slack) — `channels.slack`
- **Mattermost:** [channels/mattermost](/channels/mattermost) — `channels.mattermost`
- **Feishu / Lark:** [channels/feishu](/channels/feishu) — `channels.feishu`

Example (structure only; fill credentials via env or token files):

```json5
{
  channels: {
    msteams: { enabled: true /* accounts, tokens via env or config */ },
    googlechat: { enabled: true },
    slack: { enabled: true },
    mattermost: { enabled: true, baseUrl: "https://mattermost.corp.example.com" },
    feishu: { enabled: true, domain: "lark" },
  },
}
```

## Logging (SIEM and redaction)

For structured logs and audit-friendly output:

- **JSON:** `logging.consoleStyle: "json"` for machine-readable logs.
- **File:** `logging.file` can be a string path or `{ path: "...", rotate: true }` (rotation is reserved for future use).
- **Redaction:** `logging.redactSensitive: "tools"` (default) redacts sensitive tokens in tool summaries.

```json5
{
  logging: {
    level: "info",
    consoleStyle: "json",
    file: "./logs/openclaw-audit.log",
    redactSensitive: "tools",
  },
}
```

## Example file

A commented example is in the repo: `docs/gateway/config.enterprise.example.json5`. Copy and adapt it; merge the sections you need into your existing config.

## References

- [ConsentGate operator runbook](/reference/consentgate-operator-runbook)
- [Security](/gateway/security)
- [Configuration reference](/gateway/configuration-reference)
- [Tailscale](/gateway/tailscale)
