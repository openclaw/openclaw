---
summary: "Reuse selected non-secret settings without copying credentials or machine state"
read_when:
  - You want a repeatable single-agent deployment example
  - You need to understand what a configuration patch preserves
  - You are deciding between config patches, agent Templates, and plugin setup
title: "Repeatable setup"
---

For one new host, use [Small-host setup](/start/small-host-setup). This page is
for repeating selected settings on another host after the first chat works.
It uses the existing config, credential, Template, and plugin commands, not a
new portable-profile format.

An assistant applying this recipe should follow the
[assistant-led setup framework](/start/small-host-setup#assistant-led-setup):
inspect the destination, explain the intended non-secret changes, use existing
action owners, and report observed results. Do not make the user reconstruct
this workflow from reference pages.

## Keep configuration separate from access and state

Share only reviewed, non-secret settings. Do not copy a production config, auth
database, device identity, workspace history, channels, or schedules to create
a new installation. Onboard each destination and authorize its AI connection
separately. A password-manager reference is not permission to read that secret.

This example assumes one configured agent named `main`, a loopback token Gateway
created by onboarding, and providers you have already authorized. Before any
change on an existing host, retain a private [backup](/install/backups). Keep
that backup out of the reusable recipe.

## Review and validate a small patch

Save the following non-secret settings as `small-host.patch.json5`:

```json5
{
  gateway: { bind: "loopback" },
  agents: {
    defaults: {
      maxConcurrent: 1,
    },
  },
}
```

What this example changes:

- `gateway.bind` becomes `loopback`; this can disconnect an existing remote
  client. Review the network change locally before applying it.
- `agents.defaults.maxConcurrent` becomes `1`. This is not a limit on every
  background task or a provider spending cap.
- Model selection, credentials, Gateway authentication, agent workspace/tool
  policy, channels, plugins, and schedules are not set by this patch.

Inspect the current non-secret values, then validate without writing:

```bash
openclaw config get gateway.bind
openclaw config get agents.defaults.maxConcurrent
openclaw config patch --file ./small-host.patch.json5 --dry-run
```

An unset path may report that it was not found. Dry-run checks the resulting
configuration and eligible secret references; it is **not a before/after diff**
and does not test inference. Exec-backed secret resolution is skipped unless
you explicitly opt in. Review the patch and the current values before applying:

```bash
openclaw config patch --file ./small-host.patch.json5
openclaw config validate
```

Objects merge recursively. Arrays and scalar values replace the values at
their paths; `null` deletes a path. Unmentioned settings are preserved. Rerunning
this patch sets the same two values again; it does not create another agent.
Follow any apply/restart instruction printed by the command, then repeat the
[readiness checks](/start/small-host-setup#check-what-has-actually-passed). An
uncertain write needs inspection before retry, not a second local writer.

## Choose models without copying their credentials

Open **Models** in the Control UI to select an existing connection/model, or
use `openclaw models list --agent main` to find its full `provider/model` name.
A catalog entry or a saved selection is not proof of a live reply.

For deployments where you deliberately want the same default and ordered
fallbacks, a separate patch can set `agents.defaults.model.primary` and
`agents.defaults.model.fallbacks`. For example, **only if both routes are
authorized and available to you**:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-6-astra",
        fallbacks: ["anthropic/claude-sonnet-4-6"],
      },
    },
  },
}
```

Validate and apply it with the same `config patch --file` workflow. This
replaces the whole fallback array. A per-agent model override still takes
precedence; inspect `openclaw models status --agent main` afterward. Use actual
model IDs from your provider and retain provider-reported capability, context,
and output limits rather than inventing them for a portable recipe.

Two models on the same provider are not independent provider-outage protection.
A different-provider fallback needs its own authorized connection. Configured
fallbacks are not exercised fallbacks, and a model name does not establish
price or quota. See [Model failover](/concepts/model-failover).

## Agent behavior and optional plugins

Keep the host's models/providers outside [agent Templates](/cli/templates).
Templates can reuse instructions and workspace material, with reviewed
dependencies; they are not a host-wide model deployment format. Inspect and
preview a Template before Add. **Add creates another agent**, so do not replay
it to resume an agent retained after a partial installation.

For an optional plugin suite, record each exact version, source, compatibility
requirements, and declared capabilities before installing. Follow
[plugin management](/plugins/manage-plugins) for each reviewed artifact. Do not
put blanket capability consent into the config patch: onboarding risk
acknowledgment does not grant third-party plugin consent. Installation,
enablement, configuration, and a successful plugin operation are separate
results. Leave optional plugins out of the first-chat acceptance unless you
chose and tested them.
