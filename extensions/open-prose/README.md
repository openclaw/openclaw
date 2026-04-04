# OpenProse (plugin)

OpenProse is the OpenClaw plugin for `.prose` workflows, multi-agent orchestration, and AI workflow automation. It ships a bundled OpenProse skill pack plus the `/prose` slash command so you can run portable, markdown-first workflows inside OpenClaw.

If you are searching for an OpenClaw workflow plugin, a `.prose` runner, or a multi-agent slash command for reusable research, review, and automation flows, this is the plugin to enable.

## Why install OpenProse

- Run reusable `.prose` programs for research, debugging, documentation, and content workflows.
- Coordinate multiple agents with explicit sequential and parallel control flow.
- Keep workflow state under `.prose/` so runs are inspectable, repeatable, and easy to share.
- Start quickly with `/prose help`, `/prose examples`, or your own local `.prose` file.

## Install + enable

Bundled OpenClaw plugins are disabled by default. Enable OpenProse, restart the Gateway, then confirm that the plugin is loaded:

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

In an OpenClaw chat or TUI session, start with:

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
