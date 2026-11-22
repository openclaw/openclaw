# OpenClaw troubleshooting

Find the symptom. Run the read-only checks first. Ask the person before any command that changes state.

## Start with an overview

1. Run `openclaw status` for channel and session health.
2. Run `openclaw config validate`. The Gateway refuses to start with an invalid config.
3. Run `openclaw logs`. If RPC is down, read `~/.openclaw/logs/openclaw-<YYYY-MM-DD>.log`.

## The Gateway is not running, or its state is unclear

1. Run `openclaw gateway status --deep`. Add `--require-rpc` to exit non-zero when the Gateway does not answer.
2. Read the latest errors with `openclaw logs`.
3. If the person agrees, run `openclaw gateway start` or `openclaw gateway restart`. Both change the service.
4. If no service is installed, ask the person before `openclaw gateway install`. It installs and starts the service.

Docs: `help/troubleshooting`, `gateway/troubleshooting`.

## A phone or node cannot pair

1. Run `openclaw config get gateway.bind` and `openclaw config get gateway.tailscale.mode`.
2. If `gateway.bind` is `loopback` (the default) and `gateway.tailscale.mode` is `off` (the default), only the Gateway host can reach the Gateway.
3. If the person agrees to tailnet access, run `openclaw config set gateway.tailscale.mode serve`. Keep `gateway.bind` at `loopback`. Validation rejects `serve` or `funnel` unless the bind is loopback.
4. In the default `hybrid` reload mode, the Gateway restarts by itself when a change needs it.

Only the person can do these steps:

- Install the `tailscale` CLI on the Gateway host and log in.
- Enable Serve on the tailnet.
- Allow the Gateway port in the tailnet ACLs or grants in the Tailscale admin console.
- Install the OpenClaw app on the phone.

For route, auth, and pairing failures after that, load the `node-connect` skill. `openclaw qr` is not read-only. It issues a short-lived bootstrap token. Docs: `gateway/tailscale`, `gateway/configuration/hot-reload`.

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
5. If `openclaw status --all` reports the plugin as `configured-unavailable`, fix or reinstall it. Then ask the person before you restart the Gateway.

Plugin commands apply to a running Gateway without a restart. A stopped Gateway loads the saved changes when it starts. Docs: `tools/plugin`.

## A skill has missing requirements

1. Run `openclaw skills check`.
2. Run `openclaw skills info <name>`, or `openclaw skills list --verbose` for all skills.
3. If the person agrees, install the missing binary or set the missing config. A missing API key comes from the person.
4. If `openclaw doctor --fix` disabled the skill, run `openclaw config set skills.entries.<name>.enabled true` after the person agrees.
5. Tell the person to start a new session with `/new`. A session keeps the skills it started with.

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
4. If the person agrees, approve a new sender with `openclaw pairing approve <channel> <CODE>`.

Docs: `channels/<name>`, `channels/pairing`.
