---
summary: "CLI reference for `openclaw skills` (list/info/check) and skill eligibility"
read_when:
  - You want to see which skills are available and ready to run
  - You want to debug missing binaries/env/config for skills
title: "skills"
---

# `openclaw skills`

Inspect skills (bundled + workspace + managed overrides) and see what’s eligible vs missing requirements.

Related:

- Skills system: [Skills](/tools/skills)
- Skills config: [Skills config](/tools/skills-config)
- ClawHub installs: [ClawHub](/tools/clawhub)

## Commands

### `openclaw skills list`

List all skills with status, capabilities, and source.

```bash
openclaw skills list              # all skills
openclaw skills list --eligible   # only ready-to-use skills
openclaw skills list --json       # JSON output
openclaw skills list -v           # verbose (show missing requirements)
```

Output columns: **Status** (`+ ready`, `x missing`, `x blocked`), **Skill** (name + capability icons), **Description**, **Source**.

Capability icons displayed next to skill names:

| Icon | Capability |
|------|-----------|
| `>_` | `shell` — run shell commands |
| `📂` | `filesystem` — read/write files |
| `🌐` | `network` — outbound HTTP |
| `🔍` | `browser` — browser automation |
| `⚡` | `sessions` — cross-session orchestration |

Skills blocked by security scanning show `x blocked` instead of `x missing`.

Example output:

```
Skills (10/12 ready)

Status      Skill                          Description                          Source
+ ready     git-autopush >_ 🌐            Automate git workflows               openclaw-managed
+ ready     think                          Extended thinking                    bundled
+ ready     peekaboo 🔍 ⚡                 Browser peek and screenshot          bundled
x missing   summarize >_                   Summarize with CLI tool              bundled
x blocked   evil-injector >_               Totally harmless skill               openclaw-managed
- disabled  old-skill                      Deprecated skill                     workspace
```

With `-v` (verbose), two extra columns appear — **Scan** and **Missing**:

```
Status      Skill              Description          Source              Scan        Missing
+ ready     git-autopush >_ 🌐 Automate git wor...  openclaw-managed
x missing   summarize >_       Summarize with...    bundled                         bins: summarize
x blocked   evil-injector >_   Totally harmless...  openclaw-managed    [blocked]
+ ready     sketch-tool 🌐 >_  Generate sketches    openclaw-managed    [warn]
```

### `openclaw skills info <name>`

Show detailed information about a single skill including security status.

```bash
openclaw skills info git-helper
openclaw skills info git-helper --json
```

Displays: description, source, file path, capabilities (with descriptions), security scan results, requirements (met/unmet), and install options.

Example output:

```
git-autopush + Ready

  Automate git commit, push, and PR workflows.

  Source        openclaw-managed
  Path          ~/.openclaw/skills/git-autopush/SKILL.md
  Homepage      https://github.com/example/git-autopush
  Primary env   GH_TOKEN

  Capabilities
  >_ shell        Run shell commands
  🌐 network      Make outbound HTTP requests

  Security
  Scan          + clean

  Requirements
  bin           git         + ok
  bin           gh          + ok
  env           GH_TOKEN    + ok
```

For a skill with missing requirements:

```
summarize x Missing requirements

  Summarize URLs and files using the summarize CLI.

  Source        bundled
  Path          /opt/openclaw/skills/summarize/SKILL.md

  Capabilities
  >_ shell        Run shell commands

  Security
  Scan          + clean

  Requirements
  bin           summarize   x missing

  Install options
  brew          Install summarize (brew install summarize)
```

For a skill blocked by scanning:

```
evil-injector x Blocked (security)

  Totally harmless skill.

  Source        openclaw-managed
  Path          ~/.openclaw/skills/evil-injector/SKILL.md

  Capabilities
  >_ shell        Run shell commands

  Security
  Scan          [blocked] prompt injection detected
```

### `openclaw skills check`

Security-focused overview of all skills.

```bash
openclaw skills check
openclaw skills check --json
```

Shows: total/eligible/disabled/blocked/missing counts, capabilities requested by community skills, runtime policy restrictions, and scan result summary.

Example output:

```
Skills Status Check

Status                      Count
Total                       12
Eligible                    10
Disabled                    1
Blocked (allowlist)         0
Missing requirements        1

Community skill capabilities
Icon    Capability    #    Skills
>_      shell         3    git-autopush, deploy-helper, node-runner
📂      filesystem    2    git-autopush, file-editor
🌐      network       2    git-autopush, sketch-tool

Scan results
Result      #
Clean       11
Warning     1
Blocked     0
```
