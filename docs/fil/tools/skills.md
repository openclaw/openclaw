---
summary: "Skills: pinamamahalaan vs workspace, mga panuntunan sa gating, at config/env wiring"
read_when:
  - Pagdaragdag o pagbabago ng skills
  - Pagbabago ng skill gating o mga panuntunan sa pag-load
title: "Skills"
---

# Skills (OpenClaw)

38. Gumagamit ang OpenClaw ng **[AgentSkills](https://agentskills.io)-compatible** na mga skill folder upang turuan ang agent kung paano gumamit ng mga tool. Ang sandbox ay **hindi** minamana ang host `process.env`.

## Mga lokasyon at precedence

Ini-load ang mga skill mula sa **tatlong** lugar:

1. **Bundled skills**: kasama sa install (npm package o OpenClaw.app)
2. **Managed/local skills**: `~/.openclaw/skills`
3. **Workspace skills**: `<workspace>/skills`

Kung may conflict sa pangalan ng skill, ang precedence ay:

`<workspace>/skills` (pinakamataas) → `~/.openclaw/skills` → bundled skills (pinakamababa)

Dagdag pa rito, maaari kang mag-configure ng mga karagdagang skill folder (pinakamababang precedence) sa pamamagitan ng
`skills.load.extraDirs` sa `~/.openclaw/openclaw.json`.

## Per-agent vs shared skills

39. Sa mga **multi-agent** na setup, ang bawat agent ay may sariling workspace. .env/apiKey\` ay nalalapat lamang sa **host** runs.

- **Per-agent skills** ay nasa `<workspace>/skills` para lang sa agent na iyon.
- **Shared skills** ay nasa `~/.openclaw/skills` (managed/local) at makikita ng **lahat ng agent** sa parehong makina.
- Maaari ring magdagdag ng **shared folders** sa pamamagitan ng `skills.load.extraDirs` (pinakamababang precedence) kung gusto mo ng common skills pack na ginagamit ng maraming agent.

Kung umiiral ang parehong pangalan ng skill sa higit sa isang lugar, nalalapat ang karaniwang precedence: panalo ang workspace, kasunod ang managed/local, at pagkatapos ang bundled.

## Plugins + skills

40. Maaaring magsama ang mga plugin ng sarili nilang mga skill sa pamamagitan ng paglista ng mga `skills` directory sa `openclaw.plugin.json` (mga path na relative sa plugin root). 41. Ang mga plugin skill ay nilo-load kapag naka-enable ang plugin at nakikilahok sa mga normal na patakaran ng skill precedence.
    Ilo-load ng OpenClaw ang **bundled skills** kasama ang opsyonal na local overrides, at sinasala ang mga ito sa oras ng pag-load batay sa environment, config, at presensya ng binary. 42. Tingnan ang [Plugins](/tools/plugin) para sa discovery/config at [Tools](/tools) para sa tool surface na itinuturo ng mga skill na iyon.

## ClawHub (install + sync)

43. Ang ClawHub ay ang pampublikong skills registry para sa OpenClaw. Maaaring maghatid ang mga plugin ng sarili nilang skills sa pamamagitan ng paglista ng mga `skills` directory sa `openclaw.plugin.json` (mga path na relative sa plugin root).
44. Buong gabay: [ClawHub](/tools/clawhub).

Karaniwang daloy:

- Mag-install ng skill sa iyong workspace:
  - `clawhub install <skill-slug>`
- I-update ang lahat ng naka-install na skill:
  - `clawhub update --all`
- I-sync (scan + mag-publish ng updates):
  - `clawhub sync --all`

45. Bilang default, nag-i-install ang `clawhub` sa `./skills` sa ilalim ng iyong kasalukuyang working directory (o bumabalik sa naka-configure na OpenClaw workspace). Maaari mo silang i-gate gamit ang `metadata.openclaw.requires.config` sa config

## Mga tala sa seguridad

- entry ng plugin. Tingnan ang [Plugins](/tools/plugin) para sa discovery/config at [Tools](/tools) para sa
- 46. Mas piliin ang mga sandboxed run para sa mga hindi pinagkakatiwalaang input at mga mapanganib na tool. 47. Tingnan ang [Sandboxing](/gateway/sandboxing).
- Mag-browse sa [https://clawhub.com](https://clawhub.com).
- Para sa mas malawak na threat model at mga checklist, tingnan ang [Security](/gateway/security).

## Format (AgentSkills + Pi-compatible)

Dapat maglaman ang `SKILL.md` ng hindi bababa sa:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Mga tala:

- Sinusunod namin ang AgentSkills spec para sa layout/intent.
- Sinusuportahan ng parser na ginagamit ng embedded agent ang **single-line** na frontmatter key lamang.
- Ang `metadata` ay dapat **single-line JSON object**.
- Gamitin ang `{baseDir}` sa mga tagubilin para tukuyin ang path ng skill folder.
- Mga opsyonal na frontmatter key:
  - `homepage` — URL na ipinapakita bilang “Website” sa macOS Skills UI (sinusuportahan din sa pamamagitan ng `metadata.openclaw.homepage`).
  - Gamitin ito upang mag-discover, mag-install, mag-update, at mag-back up ng mga skill. Buong gabay: [ClawHub](/tools/clawhub).
  - Bilang default, nag-i-install ang `clawhub` sa `./skills` sa ilalim ng iyong kasalukuyang working 48. Kapag `true`, ang skill ay hindi isinasama sa model prompt (available pa rin sa pamamagitan ng user invocation).
  - Kinukuha iyon ng OpenClaw bilang `<workspace>/skills` sa susunod na session.
  - `command-tool` — pangalan ng tool na tatawagin kapag nakatakda ang `command-dispatch: tool`.
  - 49. `command-arg-mode` — `raw` (default). Basahin ang mga ito bago i-enable.

    Tinatawagan ang tool gamit ang mga param:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Gating (mga filter sa oras ng pag-load)

**Sinasala ng OpenClaw ang mga skill sa oras ng pag-load** gamit ang `metadata` (single-line JSON):

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
      },
  }
---
```

Mga field sa ilalim ng `metadata.openclaw`:

- `always: true` — laging isama ang skill (laktawan ang iba pang gate).
- `emoji` — opsyonal na emoji na ginagamit ng macOS Skills UI.
- `homepage` — opsyonal na URL na ipinapakita bilang “Website” sa macOS Skills UI.
- 50. `os` — opsyonal na listahan ng mga platform (`darwin`, `linux`, `win32`). Tingnan ang [Sandboxing](/gateway/sandboxing).
- `requires.bins` — listahan; bawat isa ay dapat umiral sa `PATH`.
- `requires.anyBins` — listahan; kahit isa ay dapat umiral sa `PATH`.
- `requires.env` — listahan; dapat umiral ang env var **o** maibigay sa config.
- `requires.config` — listahan ng mga path ng `openclaw.json` na dapat truthy.
- `skills.entries.*.env` at `skills.entries.*.apiKey` ay nag-iinject ng mga secret sa **host** process.apiKey\`.
- `install` — opsyonal na array ng installer spec na ginagamit ng macOS Skills UI (brew/node/go/uv/download).

Tala sa sandboxing:

- Sinusuri ang `requires.bins` sa **host** sa oras ng pag-load ng skill.
- If an agent is sandboxed, the binary must also exist **inside the container**.
  Install it via `agents.defaults.sandbox.docker.setupCommand` (or a custom image).
  `setupCommand` runs once after the container is created.
  Package installs also require network egress, a writable root FS, and a root user in the sandbox.
  Example: the `summarize` skill (`skills/summarize/SKILL.md`) needs the `summarize` CLI
  in the sandbox container to run there.

Halimbawa ng installer:

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

Mga tala:

- Kung maraming installer ang nakalista, pumipili ang gateway ng **iisang** preferred na opsyon (brew kapag available, kung hindi ay node).
- Kung ang lahat ng installer ay `download`, inililista ng OpenClaw ang bawat entry para makita mo ang mga available na artifact.
- Maaaring magsama ang mga installer spec ng `os: ["darwin"|"linux"|"win32"]` para salain ang mga opsyon ayon sa platform.
- Node installs honor `skills.install.nodeManager` in `openclaw.json` (default: npm; options: npm/pnpm/yarn/bun).
  This only affects **skill installs**; the Gateway runtime should still be Node
  (Bun is not recommended for WhatsApp/Telegram).
- Mga Go install: kung nawawala ang `go` at available ang `brew`, ini-install muna ng gateway ang Go sa pamamagitan ng Homebrew at itinatakda ang `GOBIN` sa `bin` ng Homebrew kapag posible.
- Mga download install: `url` (kinakailangan), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (default: auto kapag may na-detect na archive), `stripComponents`, `targetDir` (default: `~/.openclaw/tools/<skillKey>`).

Kung walang `metadata.openclaw` na naroroon, palaging eligible ang skill (maliban kung
na-disable sa config o hinarangan ng `skills.allowBundled` para sa bundled skills).

## Mga override ng config (`~/.openclaw/openclaw.json`)

Maaaring i-toggle ang mga bundled/managed skill at lagyan ng env values:

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

Tala: kung may hyphen ang pangalan ng skill, i-quote ang key (pinapayagan ng JSON5 ang mga quoted key).

Config keys match the **skill name** by default. If a skill defines
`metadata.openclaw.skillKey`, use that key under `skills.entries`.

Mga panuntunan:

- Ang `enabled: false` ay nagdi-disable sa skill kahit ito ay bundled/installed.
- `env`: ini-inject **lamang kung** hindi pa naka-set ang variable sa proseso.
- `apiKey`: convenience para sa mga skill na nagdedeklara ng `metadata.openclaw.primaryEnv`.
- `config`: opsyonal na bag para sa custom per-skill fields; dapat dito nakatira ang mga custom key.
- `allowBundled`: optional allowlist for **bundled** skills only. If set, only
  bundled skills in the list are eligible (managed/workspace skills unaffected).

## Environment injection (bawat agent run)

Kapag nagsimula ang isang agent run, ang OpenClaw ay:

1. Binabasa ang metadata ng skill.
2. Applies any `skills.entries.<key>.env` or `skills.entries.<key>.apiKey` to
   `process.env`.
3. Binubuo ang system prompt gamit ang mga **eligible** na skill.
4. Ibinabalik ang orihinal na environment matapos matapos ang run.

Ito ay **saklaw sa agent run**, hindi isang global na shell environment.

## Session snapshot (performance)

OpenClaw snapshots the eligible skills **when a session starts** and reuses that list for subsequent turns in the same session. Changes to skills or config take effect on the next new session.

Skills can also refresh mid-session when the skills watcher is enabled or when a new eligible remote node appears (see below). Think of this as a **hot reload**: the refreshed list is picked up on the next agent turn.

## Mga remote macOS node (Linux gateway)

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

- **Base overhead (kapag ≥1 skill lang):** 195 character.
- **Bawat skill:** 97 character + ang haba ng XML-escaped na mga value ng `<name>`, `<description>`, at `<location>`.

Pormula (characters):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Mga tala:

- Pinalalaki ng XML escaping ang `& < > " '` bilang mga entity (`&amp;`, `&lt;`, atbp.), na nagpapataas ng haba.
- Token counts vary by model tokenizer. A rough OpenAI-style estimate is ~4 chars/token, so **97 chars ≈ 24 tokens** per skill plus your actual field lengths.

## Lifecycle ng managed skills

OpenClaw ships a baseline set of skills as **bundled skills** as part of the
install (npm package or OpenClaw.app). `~/.openclaw/skills` exists for local
overrides (for example, pinning/patching a skill without changing the bundled
copy). Workspace skills are user-owned and override both on name conflicts.

## Sanggunian ng config

Tingnan ang [Skills config](/tools/skills-config) para sa kumpletong schema ng configuration.

## Naghahanap ng mas maraming skill?

Mag-browse sa [https://clawhub.com](https://clawhub.com).

---
