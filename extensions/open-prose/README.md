# VeriClaw OpenProse (plugin)

VeriClaw OpenProse is an AI workflow automation plugin for VeriClaw and the OpenClaw compatibility layer. Use it to run `.prose` prompt workflows for research automation, code review, documentation generation, prompt chaining, multi-agent orchestration, and reusable `/prose` slash-command automations.

If you want a prompt workflow engine, a markdown-first agent orchestrator, or a reusable AI task runner that stays inspectable in git, this is the plugin to install from ClawHub.

## Why install OpenProse

- Run reusable `.prose` workflows for research, debugging, code review, documentation, and content production.
- Coordinate multiple agents with explicit sequential, parallel, retry, and prompt-chaining control flow.
- Keep workflow state under `.prose/` so runs are inspectable, repeatable, searchable, and easy to share.
- Start quickly with `/prose help`, `/prose examples`, or your own local `.prose` file.

## Install + enable

Bundled OpenClaw plugins are disabled by default. Enable VeriClaw OpenProse, restart the Gateway, then confirm that the plugin is loaded:

```bash
openclaw plugins enable open-prose
openclaw gateway restart
openclaw plugins info open-prose
```

For a local repo checkout or dev install:

```bash
openclaw plugins install ./extensions/open-prose
openclaw plugins enable open-prose
openclaw gateway restart
```

## First successful run

In a VeriClaw chat or TUI session, start with:

```text
/prose help
```

Then try a minimal `.prose` workflow:

```prose
session "Say hello from OpenProse."
```

Save it as `hello.prose`, then run:

```text
/prose run ./hello.prose
```

## What you get

- `/prose` slash command (user-invocable skill)
- bundled `prose` skill pack
- OpenProse VM semantics (`.prose` programs + multi-agent orchestration)
- Telemetry support (best-effort, per OpenProse spec)

## Troubleshooting

- If `/prose` does not appear, run `openclaw plugins info open-prose` and make sure the status is `loaded`.
- Restart the Gateway after enabling or updating the plugin.
- If a `.prose` program fails immediately, check that your tool allowlist still permits `sessions_spawn`, `read`, `write`, and `web_fetch`.

Full documentation: [docs/prose.md](../../docs/prose.md)
