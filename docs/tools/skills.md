---
summary: "Skills: managed vs workspace, gating rules, and config/env wiring"
read_when:
  - Adding or modifying skills
  - Changing skill gating or load rules
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw uses **[AgentSkills](https://agentskills.io)-compatible** skill folders to teach the agent how to use tools. Each skill is a directory containing a `SKILL.md` with YAML frontmatter and instructions. OpenClaw loads **bundled skills** plus optional local overrides, and filters them at load time based on environment, config, and binary presence.

## Locations and precedence

Skills are loaded from **three** places:

1. **Bundled skills**: shipped with the install (npm package or OpenClaw.app)
2. **Managed/local skills**: `~/.openclaw/skills`
3. **Workspace skills**: `<workspace>/skills`

If a skill name conflicts, precedence is:

`<workspace>/skills` (highest) → `~/.openclaw/skills` → bundled skills (lowest)

Additionally, you can configure extra skill folders (lowest precedence) via
`skills.load.extraDirs` in `~/.openclaw/openclaw.json`.

## Per-agent vs shared skills

In **multi-agent** setups, each agent has its own workspace. That means:

- **Per-agent skills** live in `<workspace>/skills` for that agent only.
- **Shared skills** live in `~/.openclaw/skills` (managed/local) and are visible
  to **all agents** on the same machine.
- **Shared folders** can also be added via `skills.load.extraDirs` (lowest
  precedence) if you want a common skills pack used by multiple agents.

If the same skill name exists in more than one place, the usual precedence
applies: workspace wins, then managed/local, then bundled.

## Plugins + skills

Plugins can ship their own skills by listing `skills` directories in
`openclaw.plugin.json` (paths relative to the plugin root). Plugin skills load
when the plugin is enabled and participate in the normal skill precedence rules.
You can gate them via `metadata.openclaw.requires.config` on the plugin’s config
entry. See [Plugins](/tools/plugin) for discovery/config and [Tools](/tools) for the
tool surface those skills teach.

## ClawHub (install + sync)

ClawHub is the public skills registry for OpenClaw. Browse at
[https://clawhub.com](https://clawhub.com). Use it to discover, install, update, and back up skills.
Full guide: [ClawHub](/tools/clawhub).

Common flows:

- Install a skill into your workspace:
  - `clawhub install <skill-slug>`
- Update all installed skills:
  - `clawhub update --all`
- Sync (scan + publish updates):
  - `clawhub sync --all`

By default, `clawhub` installs into `./skills` under your current working
directory (or falls back to the configured OpenClaw workspace). OpenClaw picks
that up as `<workspace>/skills` on the next session.

## Security notes

- Treat third-party skills as **untrusted** until you have reviewed them. Runtime enforcement reduces blast radius but does not eliminate risk — read a skill's SKILL.md and declared capabilities before enabling it.
- **Capabilities**: Community skills (from ClawHub) must declare `capabilities` in `metadata.openclaw` to describe what system access they need. Skills that don't declare capabilities are treated as read-only. Undeclared dangerous tool usage (e.g., `exec` without `shell` capability) is blocked at runtime for community skills. SKILL.md content is scanned for prompt injection before entering the system prompt.
- Local and workspace skills are exempt from capability enforcement. If someone can write to your skill folders, they can inject instructions into the system prompt — restrict who can modify them.
- Prefer sandboxed runs for untrusted inputs and risky tools. See [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` and `skills.entries.*.apiKey` inject secrets into the **host** process
  for that agent turn (not the sandbox). Keep secrets out of prompts and logs.
- For a broader threat model and checklists, see [Security](/gateway/security).

### Tool enforcement matrix

When community skills are loaded, every tool falls into one of three tiers. Enforcement is applied by a hard code gate in the before-tool-call hook — prompt injection cannot bypass it.

**Always denied** — blocked unconditionally when community skills are loaded, regardless of capability declarations:

| Tool | Reason |
|------|--------|
| `gateway` | Control-plane reconfiguration (restart, shutdown, auth changes) |
| `nodes` | Cluster node management (add/remove devices, redirect traffic) |

**Capability-gated** — blocked by default, allowed when the skill declares the matching capability in `metadata.openclaw.capabilities`:

| Capability | Tools | What it unlocks |
|------------|-------|-----------------|
| `shell` | `exec`, `process`, `lobster` | Run shell commands and manage processes |
| `filesystem` | `write`, `edit`, `apply_patch` | File mutations (`read` is always allowed) |
| `network` | `web_fetch`, `web_search` | Outbound HTTP requests |
| `browser` | `browser` | Browser automation |
| `sessions` | `sessions_spawn`, `sessions_send`, `subagents` | Cross-session orchestration |
| `messaging` | `message` | Send messages to configured channels |
| `scheduling` | `cron` | Schedule recurring jobs |

**Always allowed** — safe read-only or output-only tools, no capability required:

| Tool | Why safe |
|------|---------|
| `read` | Read-only file access |
| `memory_search`, `memory_get` | Read-only memory access |
| `agents_list` | List agents (read-only) |
| `sessions_list`, `sessions_history`, `session_status` | Session introspection (read-only) |
| `canvas` | UI rendering (output-only) |
| `image` | Image generation (output-only) |
| `tts` | Text-to-speech (output-only) |

A community skill with no capabilities declared gets access only to the always-allowed tier.

### Example: correct capability declaration

This skill runs shell commands and makes HTTP requests. It declares both capabilities, so OpenClaw allows the tool calls:

```markdown
---
name: git-autopush
description: Automate git commit, push, and PR workflows.
metadata: { "openclaw": { "capabilities": ["shell", "network"], "requires": { "bins": ["git", "gh"] } } }
---

# git-autopush

When the user asks to push their changes:
1. Run `git add -A && git commit` via the exec tool.
2. Run `git push` via the exec tool.
3. If requested, create a PR using `gh pr create`.
```

`openclaw skills info git-autopush` shows:

```
git-autopush + Ready

  Automate git commit, push, and PR workflows.

  Source        openclaw-managed
  Path          ~/.openclaw/skills/git-autopush/SKILL.md

  Capabilities
  >_ shell        Run shell commands
  🌐 network      Make outbound HTTP requests

  Security
  Scan          + clean
```

### Example: missing capability declaration

This skill runs shell commands but doesn't declare `shell`. OpenClaw blocks the `exec` calls at runtime:

```markdown
---
name: deploy-helper
description: Deploy to production.
metadata: { "openclaw": { "requires": { "bins": ["rsync"] } } }
---

# deploy-helper

When the user asks to deploy, run `rsync -avz ./dist/ user@host:/var/www/` via the exec tool.
```

This skill has no `capabilities` declared, so it's treated as read-only. When the model tries to call `exec` on behalf of this skill's instructions, OpenClaw denies it. `openclaw skills info deploy-helper` shows:

```
deploy-helper + Ready

  Deploy to production.

  Source        openclaw-managed
  Path          ~/.openclaw/skills/deploy-helper/SKILL.md

  Capabilities
  (none — read-only skill)

  Security
  Scan          + clean
```

The fix is to add `"capabilities": ["shell"]` to the metadata.

### Example: blocked skill (failed security scan)

If a SKILL.md contains prompt injection patterns, the scan blocks it from loading entirely:

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

This skill never enters the system prompt. It shows as `x blocked` in `openclaw skills list`.

### How the model sees skills

The model does not see the full SKILL.md in the system prompt. It only sees a compact XML listing with three fields per skill: `name`, `description`, and `location` (the file path). The model then uses the `read` tool to load the full SKILL.md on demand when the task matches.

This is what the model receives in the system prompt:

```
## Skills (mandatory)
Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.
- If multiple could apply: choose the most specific one, then read/follow it.
- If none clearly apply: do not read any SKILL.md.
Constraints: never read more than one skill up front; only read after selecting.

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill
directory (parent of SKILL.md / dirname of the path) and use that absolute
path in tool commands.

<available_skills>
  <skill>
    <name>git-autopush</name>
    <description>Automate git commit, push, and PR workflows.</description>
    <location>/home/user/.openclaw/skills/git-autopush/SKILL.md</location>
  </skill>
  <skill>
    <name>todoist-cli</name>
    <description>Manage Todoist tasks, projects, and labels.</description>
    <location>/home/user/.openclaw/skills/todoist-cli/SKILL.md</location>
  </skill>
</available_skills>
```

**What this means for skill authors:**

- **`description` is your pitch** — it's the only thing the model reads to decide whether to load your skill. Make it specific and task-oriented. "Manage Todoist tasks, projects, and labels from the command line" is better than "Todoist integration."
- **`name` must be lowercase `[a-z0-9-]`**, max 64 characters, must match the parent directory name.
- **`description` max 1024 characters.**
- **Your SKILL.md body is loaded on demand** — it needs to be self-contained instructions the model can follow after reading.
- **Relative paths in SKILL.md** are resolved against the skill directory. Use relative paths to reference supporting files.

The `Skill` type from `@mariozechner/pi-coding-agent`:

```typescript
interface Skill {
  name: string;              // from frontmatter (or parent dir name)
  description: string;       // from frontmatter (required, max 1024 chars)
  filePath: string;          // absolute path to SKILL.md
  baseDir: string;           // parent directory of SKILL.md
  source: string;            // origin identifier
  disableModelInvocation: boolean;  // if true, excluded from prompt
}
```

## Format (AgentSkills + Pi-compatible)

`SKILL.md` must include at least:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Notes:

- We follow the AgentSkills spec for layout/intent.
- The parser used by the embedded agent supports **single-line** frontmatter keys only.
- `metadata` should be a **single-line JSON object**.
- Use `{baseDir}` in instructions to reference the skill folder path.
- Optional frontmatter keys:
  - `homepage` — URL surfaced as “Website” in the macOS Skills UI (also supported via `metadata.openclaw.homepage`).
  - `user-invocable` — `true|false` (default: `true`). When `true`, the skill is exposed as a user slash command.
  - `disable-model-invocation` — `true|false` (default: `false`). When `true`, the skill is excluded from the model prompt (still available via user invocation).
  - `command-dispatch` — `tool` (optional). When set to `tool`, the slash command bypasses the model and dispatches directly to a tool.
  - `command-tool` — tool name to invoke when `command-dispatch: tool` is set.
  - `command-arg-mode` — `raw` (default). For tool dispatch, forwards the raw args string to the tool (no core parsing).

    The tool is invoked with params:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Gating (load-time filters)

OpenClaw **filters skills at load time** using `metadata` (single-line JSON):

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
        "capabilities": ["browser", "network"],
      },
  }
---
```

Fields under `metadata.openclaw`:

- `always: true` — always include the skill (skip other gates).
- `emoji` — optional emoji used by the macOS Skills UI.
- `homepage` — optional URL shown as "Website" in the macOS Skills UI.
- `os` — optional list of platforms (`darwin`, `linux`, `win32`). If set, the skill is only eligible on those OSes.
- `capabilities` — list of system access the skill needs. Used for security enforcement and user-facing display. Allowed values:
  - `shell` — run shell commands (maps to `exec`, `process`)
  - `filesystem` — read/write/edit files (maps to `write`, `edit`, `apply_patch`; `read` is always allowed)
  - `network` — outbound HTTP (maps to `web_search`, `web_fetch`)
  - `browser` — browser automation (maps to `browser`)
  - `sessions` — cross-session orchestration (maps to `sessions_spawn`, `sessions_send`, `subagents`)
  - `messaging` — send messages to configured channels (maps to `message`)
  - `scheduling` — schedule recurring jobs (maps to `cron`)

  No capabilities declared = read-only, model-only skill. Community skills with undeclared capabilities that attempt to use dangerous tools will be blocked at runtime. See [Tool enforcement matrix](#tool-enforcement-matrix) below and [Security](/gateway/security) for full details.
- `requires.bins` — list; each must exist on `PATH`.
- `requires.anyBins` — list; at least one must exist on `PATH`.
- `requires.env` — list; env var must exist **or** be provided in config.
- `requires.config` — list of `openclaw.json` paths that must be truthy.
- `primaryEnv` — env var name associated with `skills.entries.<name>.apiKey`.
- `install` — optional array of installer specs used by the macOS Skills UI (brew/node/go/uv/download).

Note on sandboxing:

- `requires.bins` is checked on the **host** at skill load time.
- If an agent is sandboxed, the binary must also exist **inside the container**.
  Install it via `agents.defaults.sandbox.docker.setupCommand` (or a custom image).
  `setupCommand` runs once after the container is created.
  Package installs also require network egress, a writable root FS, and a root user in the sandbox.
  Example: the `summarize` skill (`skills/summarize/SKILL.md`) needs the `summarize` CLI
  in the sandbox container to run there.

Installer example:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

Notes:

- If multiple installers are listed, the gateway picks a **single** preferred option (brew when available, otherwise node).
- If all installers are `download`, OpenClaw lists each entry so you can see the available artifacts.
- Installer specs can include `os: ["darwin"|"linux"|"win32"]` to filter options by platform.
- Node installs honor `skills.install.nodeManager` in `openclaw.json` (default: npm; options: npm/pnpm/yarn/bun).
  This only affects **skill installs**; the Gateway runtime should still be Node
  (Bun is not recommended for WhatsApp/Telegram).
- Go installs: if `go` is missing and `brew` is available, the gateway installs Go via Homebrew first and sets `GOBIN` to Homebrew’s `bin` when possible.
- Download installs: `url` (required), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (default: auto when archive detected), `stripComponents`, `targetDir` (default: `~/.openclaw/tools/<skillKey>`).

If no `metadata.openclaw` is present, the skill is always eligible (unless
disabled in config or blocked by `skills.allowBundled` for bundled skills).

## Config overrides (`~/.openclaw/openclaw.json`)

Bundled/managed skills can be toggled and supplied with env values:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

Note: if the skill name contains hyphens, quote the key (JSON5 allows quoted keys).

Config keys match the **skill name** by default. If a skill defines
`metadata.openclaw.skillKey`, use that key under `skills.entries`.

Rules:

- `enabled: false` disables the skill even if it’s bundled/installed.
- `env`: injected **only if** the variable isn’t already set in the process.
- `apiKey`: convenience for skills that declare `metadata.openclaw.primaryEnv`.
- `config`: optional bag for custom per-skill fields; custom keys must live here.
- `allowBundled`: optional allowlist for **bundled** skills only. If set, only
  bundled skills in the list are eligible (managed/workspace skills unaffected).

## Environment injection (per agent run)

When an agent run starts, OpenClaw:

1. Reads skill metadata.
2. Applies any `skills.entries.<key>.env` or `skills.entries.<key>.apiKey` to
   `process.env`.
3. Builds the system prompt with **eligible** skills.
4. Restores the original environment after the run ends.

This is **scoped to the agent run**, not a global shell environment.

## Session snapshot (performance)

OpenClaw snapshots the eligible skills **when a session starts** and reuses that list for subsequent turns in the same session. Changes to skills or config take effect on the next new session.

Skills can also refresh mid-session when the skills watcher is enabled or when a new eligible remote node appears (see below). Think of this as a **hot reload**: the refreshed list is picked up on the next agent turn.

## Remote macOS nodes (Linux gateway)

If the Gateway is running on Linux but a **macOS node** is connected **with `system.run` allowed** (Exec approvals security not set to `deny`), OpenClaw can treat macOS-only skills as eligible when the required binaries are present on that node. The agent should execute those skills via the `nodes` tool (typically `nodes.run`).

This relies on the node reporting its command support and on a bin probe via `system.run`. If the macOS node goes offline later, the skills remain visible; invocations may fail until the node reconnects.

## Skills watcher (auto-refresh)

By default, OpenClaw watches skill folders and bumps the skills snapshot when `SKILL.md` files change. Configure this under `skills.load`:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## Token impact (skills list)

When skills are eligible, OpenClaw injects a compact XML list of available skills into the system prompt (via `formatSkillsForPrompt` in `pi-coding-agent`). The cost is deterministic:

- **Base overhead (only when ≥1 skill):** 195 characters.
- **Per skill:** 97 characters + the length of the XML-escaped `<name>`, `<description>`, and `<location>` values.

Formula (characters):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Notes:

- XML escaping expands `& < > " '` into entities (`&amp;`, `&lt;`, etc.), increasing length.
- Token counts vary by model tokenizer. A rough OpenAI-style estimate is ~4 chars/token, so **97 chars ≈ 24 tokens** per skill plus your actual field lengths.

## Managed skills lifecycle

OpenClaw ships a baseline set of skills as **bundled skills** as part of the
install (npm package or OpenClaw.app). `~/.openclaw/skills` exists for local
overrides (for example, pinning/patching a skill without changing the bundled
copy). Workspace skills are user-owned and override both on name conflicts.

## Config reference

See [Skills config](/tools/skills-config) for the full configuration schema.

## Looking for more skills?

Browse [https://clawhub.com](https://clawhub.com).

---
