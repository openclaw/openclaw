---
summary: "Use the 1Password plugin, bundled skill, or official MCP with OpenClaw"
read_when:
  - You want API keys out of openclaw.json and inside 1Password
  - You run the Gateway headless and need service account auth for op
  - You want agents to read, inject, or maintain secrets with 1Password
title: "1Password"
---

OpenClaw has three independent 1Password paths:

- The bundled [1Password plugin](/plugins/onepassword) resolves configured
  [SecretRefs](/gateway/secrets) and optionally exposes a curated agent tool
  with approval policy and SQLite audit history.
- The bundled `1password` skill handles direct `op` workflows such as
  discovery, item maintenance, rotation, and command injection.
- The official 1Password MCP server gives interactive desktop agents approved
  access to 1Password Environments. It is complementary to the plugin and
  skill, not a backend for either one.

## Requirements

- The [1Password CLI](https://developer.1password.com/docs/cli/get-started/)
  (`op`) installed on the Gateway host.
- A 1Password service account for the unattended plugin paths.
- For direct skill workflows, either a service account, desktop app integration,
  or standalone `op signin`.

## Resolve config secrets with the plugin

Enable the bundled plugin and create its service-account token file:

```bash
openclaw plugins enable onepassword
mkdir -p ~/.openclaw/credentials/onepassword
chmod 700 ~/.openclaw/credentials/onepassword
printf '%s' "$OP_SERVICE_ACCOUNT_TOKEN" > \
  ~/.openclaw/credentials/onepassword/service-account-token
chmod 600 ~/.openclaw/credentials/onepassword/service-account-token
unset OP_SERVICE_ACCOUNT_TOKEN
```

When `OPENCLAW_STATE_DIR` is set, use that directory instead of
`~/.openclaw`. Then generate and apply a SecretRef plan:

```bash
openclaw onepassword secretref setup \
  --openai-id op://Automation/OpenAI/credential \
  --anthropic-id op://Automation/Anthropic/credential \
  --plan-out ./openclaw-1password-secrets-plan.json

openclaw secrets apply --from ./openclaw-1password-secrets-plan.json --dry-run --allow-exec
openclaw secrets apply --from ./openclaw-1password-secrets-plan.json --allow-exec
openclaw secrets audit --check --allow-exec
openclaw secrets reload
```

The plugin accepts native
`op://<vault>/<item>/<field>` and
`op://<vault>/<item>/<section>/<field>` references. It resolves only
registered OpenClaw credential targets, bounds parallel `op read` calls, and
forces desktop-app integration off. See the
[plugin guide](/plugins/onepassword) for manual configuration, custom targets,
and the separate audited agent tool.

## The 1password skill for agents

OpenClaw bundles a `1password` skill that teaches agents to select an available
auth mode, verify access, and prefer `op run` or `op inject` over writing secret
values to disk.

Agents use it for workflows that intentionally exceed the plugin's narrow
contracts, for example creating or rotating an item or injecting credentials
into a one-off command. When a credential is already wired to an OpenClaw
SecretRef target, the owning OpenClaw workflow should resolve it; the agent does
not need to call `op` directly.

## Official 1Password MCP server

The official MCP server is a beta desktop workflow for
[1Password Environments](https://developer.1password.com/docs/environments/mcp-server/).
It requires the 1Password desktop app and explicit approval for each
interaction. It can manage environment variable names and mount values into a
local process through an in-memory `.env` file; secret values are not returned
to the MCP client or model.

It does not provide headless service-account access to arbitrary vault items,
and the OpenClaw plugin does not call it. If an MCP-managed Environment launches
OpenClaw with variables already mounted, use OpenClaw's `env` SecretRefs for
those values. Use the plugin when the Gateway itself should resolve 1Password
references on startup or reload.

## Security notes

- Secret values resolved through exec providers stay in Gateway memory; config
  snapshots and `config.get` responses redact SecretRef fields.
- The plugin resolver and broker force
  `OP_LOAD_DESKTOP_APP_SETTINGS=false` and
  `OP_BIOMETRIC_UNLOCK_ENABLED=false` so unattended reads cannot trigger
  desktop approval or macOS permission dialogs.
- Before passing the service-account token, the plugin resolves the `op`
  executable and rejects paths that are writable by another local account or
  have unverifiable Windows ACLs. An absolute `CLAW_1PASSWORD_OP` override is
  subject to the same check.
- Never place secret values in `openclaw.json`, logs, or chat. Scope the service
  account to only the vaults and items OpenClaw needs.

## Troubleshooting

- `op` is missing: install the CLI on the Gateway host, ensure it is on `PATH`,
  or set `CLAW_1PASSWORD_OP` to its absolute path.
- `op` is not trusted: use an executable owned by the current user or root and
  remove group/other write access from the executable and its parent chain.
- Authentication fails: check the plugin token file, its contents, and the
  service account's vault permissions with `openclaw onepassword status`.
- A reference is rejected: include the vault explicitly and use stable vault,
  item, section, and field IDs when names are long or contain unsupported
  1Password reference characters.
