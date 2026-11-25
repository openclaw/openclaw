# Policy

Check an OpenClaw workspace against requirements you author in `policy.jsonc`.
The plugin adds conformance findings to Doctor and provides commands for policy
checks, comparisons, and attestation evidence.

## Get started

Enable the plugin:

```bash
openclaw plugins enable policy
```

Create `policy.jsonc` in the relevant agent workspace, then run
`openclaw policy check --agent <id>`. The same findings appear in
`openclaw doctor --lint`.

Policy reports configuration drift; it does not enforce individual tool calls
or prove that stored content contains no sensitive data. Workspace repairs
require the plugin's explicit repair setting.

See the [Policy guide](https://docs.openclaw.ai/cli/policy) for authoring rules,
scope selection, and interpreting findings.
