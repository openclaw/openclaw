# OpenClaw troubleshooting

Find the symptom. Run the read-only checks first. If the person has already authorized a change, proceed within that scope and honor any runtime approvals. Ask only for authorization they have not already given. See [#157447](https://github.com/openclaw/openclaw/pull/157447).

## Start with an overview

1. Run `openclaw status` for channel and session health.
2. Run `openclaw config validate`. The Gateway refuses to start with an invalid config.
3. Run `openclaw logs`. If RPC is down, read `~/.openclaw/logs/openclaw-<YYYY-MM-DD>.log`.

## The Gateway is not running, or its state is unclear

1. Run `openclaw gateway status --deep`. Add `--require-rpc` to exit non-zero when the Gateway does not answer.
2. Read the latest errors with `openclaw logs`.
3. If authorized, run `openclaw gateway start` or `openclaw gateway restart`. Both change the service.
4. If no service is installed, `openclaw gateway install` installs and starts it. Run it only if the installation is authorized.

Docs: `help/troubleshooting`, `gateway/troubleshooting`.

## A phone or node cannot pair

Load the `node-connect` skill. Follow its live-route checks before proposing a configuration change. A loopback listener can still be reachable through an external reverse proxy or Tailscale Serve managed outside OpenClaw.

Docs: `gateway/tailscale`.

## `openclaw doctor --fix` repeats the same repair

1. Run `openclaw doctor --lint`. Exit code `1` means findings, not a failed command. Exit code `2` means the checks did not finish.
2. Do not run plain `openclaw doctor` to look. It can copy legacy config and migrate state without `--fix`.
3. If a finding stays after a repair, Doctor reports a repair warning. Running `--fix` again does not resolve a manual recovery condition, such as an unsupported workspace version or a conflicting exec policy.
4. Tell the person the path and next action that the diagnosis names. The person does the manual recovery.

Docs: `cli/doctor`.

## A plugin is enabled but does not work

1. Run `openclaw plugins list`.
2. Run `openclaw plugins inspect <id> --runtime --json`.
3. Run `openclaw plugins doctor`. It checks loading and config without asking the running Gateway.
4. Run `openclaw gateway status --deep --require-rpc` to confirm which Gateway runs.
5. If `openclaw status --all` reports the plugin as `configured-unavailable`, fix or reinstall it. Restart the Gateway only if a restart is needed and authorized.

Plugin commands apply to a running Gateway without a restart. A stopped Gateway loads the saved changes when it starts. Docs: `tools/plugin`.

## A skill has missing requirements

1. Run `openclaw skills check`.
2. Run `openclaw skills info <name>`, or `openclaw skills list --verbose` for all skills.
3. If authorized, install the missing binary or set the missing config. A missing API key comes from the person.
4. If `openclaw doctor --fix` disabled the skill, run `openclaw config set skills.entries.<name>.enabled true` if the change is authorized.
5. With skill watching enabled, changes to eligible file-backed skills can appear on the next turn in an existing session. See `tools/skills#snapshots-and-refresh`.

Docs: `tools/skills`.

## No model answers

1. Run `openclaw models status`. It does not call a model.
2. Add `--check` to get an exit code. Code `1` means missing or expired auth, an incompatible route, or an unavailable runtime. Code `2` means a credential expires soon.
3. Do not add `--probe` unless the person asks. It sends real requests that can spend tokens, and it refuses while a Gateway owns the state directory.
4. The person signs in with `openclaw models auth login --provider <id>` or `openclaw onboard`. A browser OAuth sign-in or an API key comes from the person.

Docs: `providers/index`, `concepts/models`, `cli/models`.

## A channel does not answer

1. Run `openclaw channels status`. It reads recorded state only.
2. Add `--probe` only when you need live checks. It calls the channel provider.
3. The person gets bot tokens, such as a Telegram token from BotFather.
4. If authorized, approve a new sender with `openclaw pairing approve <channel> <CODE>`.

Docs: `channels/<name>`, `channels/pairing`.
