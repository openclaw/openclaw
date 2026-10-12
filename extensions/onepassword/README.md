# @openclaw/onepassword

Resolve OpenClaw SecretRefs from 1Password and give agents access to a curated
set of secrets with approval policy and audit history.

The plugin is also included in OpenClaw. It uses the official `op` CLI and a
1Password service account on the Gateway host. Follow the
[1Password plugin guide](https://docs.openclaw.ai/plugins/onepassword) to prepare
the CLI, token file, SecretRefs, and optional agent registry.

The SecretRef integration and agent tool are separate, opt-in surfaces.
Enabling the plugin alone does not expose the tool: the agent registry must
also name the permitted items. Each registered item can allow access, require
approval, or deny access; approval is the default policy.

Keep the service-account token in the credentials file described by the guide,
not in plugin configuration. Scope the service account to the required items.
Requested secret values are visible to the model for that execution; the
plugin redacts its own persisted tool result but cannot prevent the model from
copying a value into later output. Keep access reasons non-sensitive because
they are recorded in the audit history.

`openclaw onepassword status` reports local readiness without fetching a secret.
`openclaw onepassword audit` shows recent access outcomes. Installation does
not create a service account or grant access to a vault.
