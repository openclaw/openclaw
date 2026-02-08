---
summary: "Skills: pinamamahalaan vs workspace, mga panuntunan sa gating, at config/env wiring"
read_when:
  - Pagdaragdag o pagbabago ng skills
  - Pagbabago ng skill gating o mga panuntunan sa pag-load
title: "Skills"
x-i18n:
  source_path: tools/skills.md
  source_hash: 70d7eb9e422c17a4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:27Z
---

# Skills (OpenClaw)

Gumagamit ang OpenClaw ng **[AgentSkills](https://agentskills.io)-compatible** na mga folder ng skill para turuan ang agent kung paano gumamit ng mga tool. Ang bawat skill ay isang direktoryo na naglalaman ng `SKILL.md` na may YAML frontmatter at mga tagubilin. Ini-load ng OpenClaw ang **bundled skills** kasama ang mga opsyonal na local override, at sini-sala ang mga ito sa oras ng pag-load batay sa environment, config, at presensya ng binary.

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

Sa mga **multi-agent** na setup, bawat agent ay may sariling workspace. Ibig sabihin:

- **Per-agent skills** ay nasa `<workspace>/skills` para lang sa agent na iyon.
- **Shared skills** ay nasa `~/.openclaw/skills` (managed/local) at makikita ng **lahat ng agent** sa parehong makina.
- Maaari ring magdagdag ng **shared folders** sa pamamagitan ng `skills.load.extraDirs` (pinakamababang precedence) kung gusto mo ng common skills pack na ginagamit ng maraming agent.

Kung umiiral ang parehong pangalan ng skill sa higit sa isang lugar, nalalapat ang karaniwang precedence: panalo ang workspace, kasunod ang managed/local, at pagkatapos ang bundled.

## Plugins + skills

Maaaring mag-ship ang mga plugin ng sarili nilang skills sa pamamagitan ng paglista ng mga direktoryong `skills` sa
`openclaw.plugin.json` (mga path na relative sa plugin root). Ang mga skill ng plugin ay nilo-load kapag naka-enable ang plugin at sumasali sa normal na mga panuntunan ng precedence ng skill.
Maaari mo silang i-gate sa pamamagitan ng `metadata.openclaw.requires.config` sa config entry ng plugin.
Tingnan ang [Plugins](/tools/plugin) para sa discovery/config at [Tools](/tools) para sa tool surface na itinuturo ng mga skill na iyon.

## ClawHub (install + sync)

Ang ClawHub ay ang pampublikong skills registry para sa OpenClaw. Mag-browse sa
[https://clawhub.com](https://clawhub.com). Gamitin ito para mag-discover, mag-install, mag-update, at mag-back up ng skills.
Buong gabay: [ClawHub](/tools/clawhub).

Karaniwang daloy:

- Mag-install ng skill sa iyong workspace:
  - `clawhub install <skill-slug>`
- I-update ang lahat ng naka-install na skill:
  - `clawhub update --all`
- I-sync (scan + mag-publish ng updates):
  - `clawhub sync --all`

Bilang default, ini-install ng `clawhub` sa `./skills` sa ilalim ng iyong kasalukuyang working
directory (o babalik sa naka-configure na OpenClaw workspace). Kinukuha iyon ng OpenClaw bilang `<workspace>/skills` sa susunod na session.

## Mga tala sa seguridad

- Ituring ang mga third-party skill bilang **hindi pinagkakatiwalaang code**. Basahin ang mga ito bago i-enable.
- Mas mainam ang mga sandboxed run para sa mga hindi pinagkakatiwalaang input at mga risky na tool. Tingnan ang [Sandboxing](/gateway/sandboxing).
- Ang `skills.entries.*.env` at `skills.entries.*.apiKey` ay nag-i-inject ng mga secret sa **host** na proseso para sa agent turn na iyon (hindi sa sandbox). Ilayo ang mga secret sa mga prompt at log.
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
  - `user-invocable` — `true|false` (default: `true`). Kapag `true`, inilalantad ang skill bilang user slash command.
  - `disable-model-invocation` — `true|false` (default: `false`). Kapag `true`, hindi isinasama ang skill sa model prompt (available pa rin sa user invocation).
  - `command-dispatch` — `tool` (opsyonal). Kapag nakatakda sa `tool`, nilalampasan ng slash command ang model at direktang dine-dispatch sa isang tool.
  - `command-tool` — pangalan ng tool na tatawagin kapag nakatakda ang `command-dispatch: tool`.
  - `command-arg-mode` — `raw` (default). Para sa tool dispatch, ipinapasa ang raw args string sa tool (walang core parsing).

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
- `os` — opsyonal na listahan ng mga platform (`darwin`, `linux`, `win32`). Kapag nakatakda, eligible lang ang skill sa mga OS na iyon.
- `requires.bins` — listahan; bawat isa ay dapat umiral sa `PATH`.
- `requires.anyBins` — listahan; kahit isa ay dapat umiral sa `PATH`.
- `requires.env` — listahan; dapat umiral ang env var **o** maibigay sa config.
- `requires.config` — listahan ng mga path ng `openclaw.json` na dapat truthy.
- `primaryEnv` — pangalan ng env var na kaugnay ng `skills.entries.<name>.apiKey`.
- `install` — opsyonal na array ng installer spec na ginagamit ng macOS Skills UI (brew/node/go/uv/download).

Tala sa sandboxing:

- Sinusuri ang `requires.bins` sa **host** sa oras ng pag-load ng skill.
- Kung ang agent ay naka-sandbox, dapat umiral din ang binary **sa loob ng container**.
  I-install ito sa pamamagitan ng `agents.defaults.sandbox.docker.setupCommand` (o custom image).
  Ang `setupCommand` ay tumatakbo nang isang beses matapos malikha ang container.
  Nangangailangan din ang mga package install ng network egress, writable na root FS, at root user sa sandbox.
  Halimbawa: ang `summarize` na skill (`skills/summarize/SKILL.md`) ay nangangailangan ng `summarize` CLI
  sa sandbox container para tumakbo roon.

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
- Iginagalang ng mga Node install ang `skills.install.nodeManager` sa `openclaw.json` (default: npm; mga opsyon: npm/pnpm/yarn/bun).
  Nakakaapekto ito **lamang sa mga skill install**; ang Gateway runtime ay dapat Node pa rin
  (hindi inirerekomenda ang Bun para sa WhatsApp/Telegram).
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

Tumutugma ang mga config key sa **pangalan ng skill** bilang default. Kung ang isang skill ay nagde-define ng
`metadata.openclaw.skillKey`, gamitin ang key na iyon sa ilalim ng `skills.entries`.

Mga panuntunan:

- Ang `enabled: false` ay nagdi-disable sa skill kahit ito ay bundled/installed.
- `env`: ini-inject **lamang kung** hindi pa naka-set ang variable sa proseso.
- `apiKey`: convenience para sa mga skill na nagdedeklara ng `metadata.openclaw.primaryEnv`.
- `config`: opsyonal na bag para sa custom per-skill fields; dapat dito nakatira ang mga custom key.
- `allowBundled`: opsyonal na allowlist para sa **bundled** skills lamang. Kapag nakatakda, ang mga bundled skill lang sa listahan ang eligible (hindi apektado ang managed/workspace skills).

## Environment injection (bawat agent run)

Kapag nagsimula ang isang agent run, ang OpenClaw ay:

1. Binabasa ang metadata ng skill.
2. Inilalapat ang anumang `skills.entries.<key>.env` o `skills.entries.<key>.apiKey` sa
   `process.env`.
3. Binubuo ang system prompt gamit ang mga **eligible** na skill.
4. Ibinabalik ang orihinal na environment matapos matapos ang run.

Ito ay **saklaw sa agent run**, hindi isang global na shell environment.

## Session snapshot (performance)

Kumukuha ng snapshot ang OpenClaw ng mga eligible na skill **kapag nagsimula ang isang session** at muling ginagamit ang listahang iyon para sa mga susunod na turn sa parehong session. Magkakabisa ang mga pagbabago sa skills o config sa susunod na bagong session.

Maaari ring mag-refresh ang skills sa kalagitnaan ng session kapag naka-enable ang skills watcher o kapag may bagong eligible na remote node na lumitaw (tingnan sa ibaba). Isipin ito bilang **hot reload**: kukunin ang na-refresh na listahan sa susunod na agent turn.

## Mga remote macOS node (Linux gateway)

Kung ang Gateway ay tumatakbo sa Linux ngunit may **macOS node** na nakakonekta **na may `system.run` na pinapayagan** (ang Exec approvals security ay hindi nakatakda sa `deny`), maaaring ituring ng OpenClaw ang mga macOS-only skill bilang eligible kapag naroroon ang mga kinakailangang binary sa node na iyon. Dapat isagawa ng agent ang mga skill na iyon sa pamamagitan ng tool na `nodes` (karaniwan ay `nodes.run`).

Umaasa ito sa pag-uulat ng node ng command support nito at sa bin probe sa pamamagitan ng `system.run`. Kung mag-offline ang macOS node sa bandang huli, mananatiling nakikita ang mga skill; maaaring mag-fail ang mga invocation hanggang sa muling kumonekta ang node.

## Skills watcher (auto-refresh)

Bilang default, binabantayan ng OpenClaw ang mga skill folder at tina-taas ang skills snapshot kapag nagbago ang mga file na `SKILL.md`. I-configure ito sa ilalim ng `skills.load`:

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

Kapag eligible ang mga skill, nag-i-inject ang OpenClaw ng isang compact na XML list ng mga available na skill sa system prompt (sa pamamagitan ng `formatSkillsForPrompt` sa `pi-coding-agent`). Deterministiko ang gastos:

- **Base overhead (kapag ≥1 skill lang):** 195 character.
- **Bawat skill:** 97 character + ang haba ng XML-escaped na mga value ng `<name>`, `<description>`, at `<location>`.

Pormula (characters):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Mga tala:

- Pinalalaki ng XML escaping ang `& < > " '` bilang mga entity (`&amp;`, `&lt;`, atbp.), na nagpapataas ng haba.
- Nag-iiba ang bilang ng token ayon sa tokenizer ng model. Isang magaspang na OpenAI-style na estima ay ~4 chars/token, kaya **97 chars ≈ 24 token** bawat skill plus ang aktuwal na haba ng iyong mga field.

## Lifecycle ng managed skills

Nagpapadala ang OpenClaw ng baseline na set ng skills bilang **bundled skills** bilang bahagi ng
install (npm package o OpenClaw.app). Umiiral ang `~/.openclaw/skills` para sa mga local
override (halimbawa, pag-pin/pag-patch ng skill nang hindi binabago ang bundled
copy). Ang mga workspace skill ay pag-aari ng user at ino-override ang dalawa kapag may conflict sa pangalan.

## Sanggunian ng config

Tingnan ang [Skills config](/tools/skills-config) para sa kumpletong schema ng configuration.

## Naghahanap ng mas maraming skill?

Mag-browse sa [https://clawhub.com](https://clawhub.com).

---
