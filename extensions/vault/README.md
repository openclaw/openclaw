# Vault

Resolve OpenClaw credentials from HashiCorp Vault using SecretRefs. Configuration
stores references to Vault fields; resolved secrets stay in the active runtime
snapshot instead of being written back into OpenClaw configuration.

## Get started

Enable the plugin with `openclaw plugins enable vault`. Give the Gateway a
reachable `VAULT_ADDR` and scoped Vault authentication, then check
`openclaw vault status`.

Use `openclaw vault setup --help` to select credential targets and generate a
SecretRef plan. Preview the saved plan before applying it:

```bash
openclaw secrets apply --from ./vault-secrets-plan.json --dry-run --allow-exec
```

Follow the guide to apply the reviewed plan and reload secrets.

The resolver supports Vault KV secrets and needs read permission for the
selected paths. Enabling the plugin does not provision a Vault server.

See the [Vault guide](https://docs.openclaw.ai/plugins/vault) for authentication
methods, plan commands, and deployment examples.
