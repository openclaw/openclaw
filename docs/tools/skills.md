---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Skills: managed vs workspace, gating rules, and config/env wiring"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing skill gating or load rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Skills"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Skills (OpenClaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses **[AgentSkills](https://agentskills.io)-compatible** skill folders to teach the agent how to use tools. Each skill is a directory containing a `SKILL.md` with YAML frontmatter and instructions. OpenClaw loads **bundled skills** plus optional local overrides, and filters them at load time based on environment, config, and binary presence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Locations and precedence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skills are loaded from **three** places:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Bundled skills**: shipped with the install (npm package or OpenClaw.app)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Managed/local skills**: `~/.openclaw/skills`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Workspace skills**: `<workspace>/skills`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a skill name conflicts, precedence is:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`<workspace>/skills` (highest) → `~/.openclaw/skills` → bundled skills (lowest)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Additionally, you can configure extra skill folders (lowest precedence) via（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`skills.load.extraDirs` in `~/.openclaw/openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Per-agent vs shared skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In **multi-agent** setups, each agent has its own workspace. That means:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Per-agent skills** live in `<workspace>/skills` for that agent only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Shared skills** live in `~/.openclaw/skills` (managed/local) and are visible（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  to **all agents** on the same machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Shared folders** can also be added via `skills.load.extraDirs` (lowest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  precedence) if you want a common skills pack used by multiple agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the same skill name exists in more than one place, the usual precedence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
applies: workspace wins, then managed/local, then bundled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugins + skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins can ship their own skills by listing `skills` directories in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw.plugin.json` (paths relative to the plugin root). Plugin skills load（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
when the plugin is enabled and participate in the normal skill precedence rules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can gate them via `metadata.openclaw.requires.config` on the plugin’s config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
entry. See [Plugins](/tools/plugin) for discovery/config and [Tools](/tools) for the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tool surface those skills teach.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## ClawHub (install + sync)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ClawHub is the public skills registry for OpenClaw. Browse at（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[https://clawhub.com](https://clawhub.com). Use it to discover, install, update, and back up skills.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full guide: [ClawHub](/tools/clawhub).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common flows:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install a skill into your workspace:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `clawhub install <skill-slug>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update all installed skills:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `clawhub update --all`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sync (scan + publish updates):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `clawhub sync --all`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, `clawhub` installs into `./skills` under your current working（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
directory (or falls back to the configured OpenClaw workspace). OpenClaw picks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
that up as `<workspace>/skills` on the next session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Treat third-party skills as **untrusted code**. Read them before enabling.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer sandboxed runs for untrusted inputs and risky tools. See [Sandboxing](/gateway/sandboxing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `skills.entries.*.env` and `skills.entries.*.apiKey` inject secrets into the **host** process（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  for that agent turn (not the sandbox). Keep secrets out of prompts and logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For a broader threat model and checklists, see [Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Format (AgentSkills + Pi-compatible)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`SKILL.md` must include at least:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: nano-banana-pro（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Generate or edit images via Gemini 3 Pro Image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- We follow the AgentSkills spec for layout/intent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The parser used by the embedded agent supports **single-line** frontmatter keys only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `metadata` should be a **single-line JSON object**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `{baseDir}` in instructions to reference the skill folder path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional frontmatter keys:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `homepage` — URL surfaced as “Website” in the macOS Skills UI (also supported via `metadata.openclaw.homepage`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `user-invocable` — `true|false` (default: `true`). When `true`, the skill is exposed as a user slash command.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `disable-model-invocation` — `true|false` (default: `false`). When `true`, the skill is excluded from the model prompt (still available via user invocation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `command-dispatch` — `tool` (optional). When set to `tool`, the slash command bypasses the model and dispatches directly to a tool.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `command-tool` — tool name to invoke when `command-dispatch: tool` is set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `command-arg-mode` — `raw` (default). For tool dispatch, forwards the raw args string to the tool (no core parsing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    The tool is invoked with params:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gating (load-time filters)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw **filters skills at load time** using `metadata` (single-line JSON):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: nano-banana-pro（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Generate or edit images via Gemini 3 Pro Image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "primaryEnv": "GEMINI_API_KEY",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fields under `metadata.openclaw`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `always: true` — always include the skill (skip other gates).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `emoji` — optional emoji used by the macOS Skills UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `homepage` — optional URL shown as “Website” in the macOS Skills UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `os` — optional list of platforms (`darwin`, `linux`, `win32`). If set, the skill is only eligible on those OSes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requires.bins` — list; each must exist on `PATH`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requires.anyBins` — list; at least one must exist on `PATH`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requires.env` — list; env var must exist **or** be provided in config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requires.config` — list of `openclaw.json` paths that must be truthy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `primaryEnv` — env var name associated with `skills.entries.<name>.apiKey`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `install` — optional array of installer specs used by the macOS Skills UI (brew/node/go/uv/download).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note on sandboxing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requires.bins` is checked on the **host** at skill load time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If an agent is sandboxed, the binary must also exist **inside the container**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Install it via `agents.defaults.sandbox.docker.setupCommand` (or a custom image).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `setupCommand` runs once after the container is created.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Package installs also require network egress, a writable root FS, and a root user in the sandbox.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Example: the `summarize` skill (`skills/summarize/SKILL.md`) needs the `summarize` CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  in the sandbox container to run there.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Installer example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: gemini（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Use Gemini CLI for coding assistance and Google search lookups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "♊️",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["gemini"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "gemini-cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["gemini"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install Gemini CLI (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If multiple installers are listed, the gateway picks a **single** preferred option (brew when available, otherwise node).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If all installers are `download`, OpenClaw lists each entry so you can see the available artifacts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Installer specs can include `os: ["darwin"|"linux"|"win32"]` to filter options by platform.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node installs honor `skills.install.nodeManager` in `openclaw.json` (default: npm; options: npm/pnpm/yarn/bun).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  This only affects **skill installs**; the Gateway runtime should still be Node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (Bun is not recommended for WhatsApp/Telegram).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Go installs: if `go` is missing and `brew` is available, the gateway installs Go via Homebrew first and sets `GOBIN` to Homebrew’s `bin` when possible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Download installs: `url` (required), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (default: auto when archive detected), `stripComponents`, `targetDir` (default: `~/.openclaw/tools/<skillKey>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If no `metadata.openclaw` is present, the skill is always eligible (unless（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
disabled in config or blocked by `skills.allowBundled` for bundled skills).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config overrides (`~/.openclaw/openclaw.json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bundled/managed skills can be toggled and supplied with env values:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skills: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    entries: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "nano-banana-pro": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "GEMINI_KEY_HERE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        env: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          GEMINI_API_KEY: "GEMINI_KEY_HERE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        config: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          endpoint: "https://example.invalid",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          model: "nano-pro",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      peekaboo: { enabled: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sag: { enabled: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: if the skill name contains hyphens, quote the key (JSON5 allows quoted keys).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config keys match the **skill name** by default. If a skill defines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`metadata.openclaw.skillKey`, use that key under `skills.entries`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Rules:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled: false` disables the skill even if it’s bundled/installed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `env`: injected **only if** the variable isn’t already set in the process.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `apiKey`: convenience for skills that declare `metadata.openclaw.primaryEnv`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config`: optional bag for custom per-skill fields; custom keys must live here.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowBundled`: optional allowlist for **bundled** skills only. If set, only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bundled skills in the list are eligible (managed/workspace skills unaffected).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Environment injection (per agent run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When an agent run starts, OpenClaw:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Reads skill metadata.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Applies any `skills.entries.<key>.env` or `skills.entries.<key>.apiKey` to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   `process.env`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Builds the system prompt with **eligible** skills.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Restores the original environment after the run ends.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is **scoped to the agent run**, not a global shell environment.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session snapshot (performance)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw snapshots the eligible skills **when a session starts** and reuses that list for subsequent turns in the same session. Changes to skills or config take effect on the next new session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skills can also refresh mid-session when the skills watcher is enabled or when a new eligible remote node appears (see below). Think of this as a **hot reload**: the refreshed list is picked up on the next agent turn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote macOS nodes (Linux gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway is running on Linux but a **macOS node** is connected **with `system.run` allowed** (Exec approvals security not set to `deny`), OpenClaw can treat macOS-only skills as eligible when the required binaries are present on that node. The agent should execute those skills via the `nodes` tool (typically `nodes.run`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This relies on the node reporting its command support and on a bin probe via `system.run`. If the macOS node goes offline later, the skills remain visible; invocations may fail until the node reconnects.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Skills watcher (auto-refresh)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, OpenClaw watches skill folders and bumps the skills snapshot when `SKILL.md` files change. Configure this under `skills.load`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skills: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    load: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      watch: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      watchDebounceMs: 250,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Token impact (skills list)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When skills are eligible, OpenClaw injects a compact XML list of available skills into the system prompt (via `formatSkillsForPrompt` in `pi-coding-agent`). The cost is deterministic:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Base overhead (only when ≥1 skill):** 195 characters.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Per skill:** 97 characters + the length of the XML-escaped `<name>`, `<description>`, and `<location>` values.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Formula (characters):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- XML escaping expands `& < > " '` into entities (`&amp;`, `&lt;`, etc.), increasing length.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Token counts vary by model tokenizer. A rough OpenAI-style estimate is ~4 chars/token, so **97 chars ≈ 24 tokens** per skill plus your actual field lengths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Managed skills lifecycle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw ships a baseline set of skills as **bundled skills** as part of the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
install (npm package or OpenClaw.app). `~/.openclaw/skills` exists for local（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
overrides (for example, pinning/patching a skill without changing the bundled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
copy). Workspace skills are user-owned and override both on name conflicts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Skills config](/tools/skills-config) for the full configuration schema.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Looking for more skills?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Browse [https://clawhub.com](https://clawhub.com).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
