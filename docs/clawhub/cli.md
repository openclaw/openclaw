---
summary: "ClawHub CLI entry points for discovering, installing, publishing, and verifying OpenClaw skills and plugins."
read_when:
  - You want to use ClawHub from the command line
  - You want to install ClawHub skills or plugins through OpenClaw
  - You want to publish ClawHub packages
title: "ClawHub CLI"
---

# ClawHub CLI

OpenClaw has two command-line entry points for ClawHub:

- `openclaw skills` and `openclaw plugins` install and manage ClawHub packages
  inside OpenClaw.
- The standalone `clawhub` CLI handles publisher workflows such as login,
  publish, transfer, and sync.

## Discover and install

Use OpenClaw commands when you want to install or update packages for a local
OpenClaw agent or Gateway.

```bash
openclaw skills search "calendar"
openclaw skills install @owner/<slug>
openclaw skills install @owner/<slug> --acknowledge-clawhub-risk
openclaw skills update @owner/<slug>
openclaw skills update @owner/<slug> --acknowledge-clawhub-risk
openclaw skills verify @owner/<slug>

openclaw plugins search "calendar"
openclaw plugins install clawhub:<package>
openclaw plugins install clawhub:<package> --acknowledge-clawhub-risk
openclaw plugins update <id-or-npm-spec>
```

Skill installs target the active workspace `skills/` directory by default. Add
`--global` to install into the shared managed skills directory.

OpenClaw checks the selected community ClawHub skill or plugin trust state
before downloading it. Versioned community skill and plugin releases use
exact-release trust metadata; resolver-backed GitHub skills rely on ClawHub's
install resolver to enforce scan and force-install policy before it returns a
pinned commit. Malicious or blocked community releases are refused. Risky
community releases require review and `--acknowledge-clawhub-risk` when a
non-interactive command should continue after that review.

Official ClawHub publishers/packages and bundled OpenClaw sources bypass this
release-trust prompt and security-verdict fetch during install and update.

Plugin installs use the `clawhub:` prefix when you want ClawHub resolution
instead of npm or another install source.

## Publish and maintain

Install the standalone ClawHub CLI for publisher workflows:

```bash
npm i -g clawhub
clawhub login
```

Publish plugin packages with `clawhub package publish`:

```bash
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
clawhub package publish your-org/your-plugin@v1.0.0
```

Publish skill folders with `clawhub skill publish`:

```bash
clawhub skill publish ./skills/review-helper
clawhub skill publish ./skills/review-helper --version 1.0.0
```

When local skill scan state or package ownership needs maintenance, use the
relevant standalone command:

```bash
clawhub sync --all
clawhub package transfer @old-owner/package --to new-owner
```

## Related

- [`openclaw skills`](/cli/skills) - local skill search, install, update, and
  verification
- [`openclaw plugins`](/cli/plugins) - plugin search, install, update, and
  inspection
- [ClawHub publishing](/clawhub/publishing) - owner scope, release validation,
  and review flow
- [Creating skills](/tools/creating-skills) - skill authoring and publish flow
- [Building plugins](/plugins/building-plugins) - plugin package authoring
