---
summary: "Skills: beheerd vs werkruimte, afschermingsregels en config/env-koppeling"
read_when:
  - Skills toevoegen of wijzigen
  - Skill-afscherming of laadregels wijzigen
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw gebruikt **[AgentSkills](https://agentskills.io)-compatibele** skill-mappen om de agent te leren hoe tools te gebruiken. Elke skill is een map die een `SKILL.md` bevat met YAML-frontmatter en instructies. OpenClaw laadt **gebundelde skills** plus optionele lokale overrides, en filtert ze tijdens het laden op basis van omgeving, config en aanwezigheid van binaries.

## Locaties en prioriteit

Skills worden geladen vanaf **drie** plaatsen:

1. **Gebundelde skills**: meegeleverd met de installatie (npm-pakket of OpenClaw.app)
2. **Beheerde/lokale skills**: `~/.openclaw/skills`
3. **Werkruimte-skills**: `<workspace>/skills`

Als een skillnaam conflicteert, is de prioriteit:

`<workspace>/skills` (hoogst) → `~/.openclaw/skills` → gebundelde skills (laagst)

Daarnaast kun je extra skill-mappen configureren (laagste prioriteit) via
`skills.load.extraDirs` in `~/.openclaw/openclaw.json`.

## Per-agent vs gedeelde skills

In **multi-agent**-opstellingen heeft elke agent zijn eigen werkruimte. Dat betekent:

- **Per-agent skills** staan in `<workspace>/skills` en gelden alleen voor die agent.
- **Gedeelde skills** staan in `~/.openclaw/skills` (beheerd/lokaal) en zijn zichtbaar
  voor **alle agents** op dezelfde machine.
- **Gedeelde mappen** kunnen ook worden toegevoegd via `skills.load.extraDirs` (laagste
  prioriteit) als je een gemeenschappelijk skill-pakket wilt gebruiken door meerdere agents.

Als dezelfde skillnaam op meer dan één plek bestaat, geldt de gebruikelijke
prioriteit: werkruimte wint, daarna beheerd/lokaal, daarna gebundeld.

## Plugins + skills

Plugins kunnen hun eigen skills meeleveren door `skills`-mappen te vermelden in
`openclaw.plugin.json` (paden relatief aan de plugin-root). Plugin-skills laden
wanneer de plugin is ingeschakeld en doen mee aan de normale prioriteitsregels.
Je kunt ze afschermen via `metadata.openclaw.requires.config` op de config-invoer van de plugin. Zie [Plugins](/tools/plugin) voor discovery/config en [Tools](/tools) voor het
tool-oppervlak dat deze skills aanleren.

## ClawHub (installeren + synchroniseren)

ClawHub is het openbare skills-register voor OpenClaw. Blader op
[https://clawhub.com](https://clawhub.com). Gebruik het om skills te ontdekken, installeren, bij te werken en te back-uppen.
Volledige handleiding: [ClawHub](/tools/clawhub).

Veelvoorkomende flows:

- Een skill in je werkruimte installeren:
  - `clawhub install <skill-slug>`
- Alle geïnstalleerde skills bijwerken:
  - `clawhub update --all`
- Synchroniseren (scannen + updates publiceren):
  - `clawhub sync --all`

Standaard installeert `clawhub` in `./skills` onder je huidige werkmap
(of valt terug op de geconfigureerde OpenClaw-werkruimte). OpenClaw pikt dit
op als `<workspace>/skills` bij de volgende sessie.

## Beveiligingsnotities

- Behandel skills van derden als **onbetrouwbare code**. Lees ze voordat je ze inschakelt.
- Geef de voorkeur aan gesandboxde runs voor onbetrouwbare invoer en risicovolle tools. Zie [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` en `skills.entries.*.apiKey` injecteren secrets in het **host**-proces
  voor die agentbeurt (niet de sandbox). Houd secrets uit prompts en logs.
- Voor een breder dreigingsmodel en checklists, zie [Security](/gateway/security).

## Formaat (AgentSkills + Pi-compatibel)

`SKILL.md` moet minimaal bevatten:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Notities:

- We volgen de AgentSkills-specificatie voor lay-out/intentie.
- De parser die door de ingebedde agent wordt gebruikt ondersteunt alleen **éénregelige** frontmatter-sleutels.
- `metadata` moet een **éénregelig JSON-object** zijn.
- Gebruik `{baseDir}` in instructies om naar het skill-mappad te verwijzen.
- Optionele frontmatter-sleutels:
  - `homepage` — URL die wordt getoond als “Website” in de macOS Skills-UI (ook ondersteund via `metadata.openclaw.homepage`).
  - `user-invocable` — `true|false` (standaard: `true`). Wanneer `true`, wordt de skill blootgesteld als een gebruikers-slash-commando.
  - `disable-model-invocation` — `true|false` (standaard: `false`). Wanneer `true`, wordt de skill uitgesloten van de modelprompt (nog steeds beschikbaar via gebruikersaanroep).
  - `command-dispatch` — `tool` (optioneel). Wanneer ingesteld op `tool`, omzeilt het slash-commando het model en wordt direct naar een tool gedispatcht.
  - `command-tool` — toolnaam om aan te roepen wanneer `command-dispatch: tool` is ingesteld.
  - `command-arg-mode` — `raw` (standaard). Voor tool-dispatch stuurt dit de ruwe args-string door naar de tool (geen core-parsing).

    De tool wordt aangeroepen met params:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Afscherming (filters bij laden)

OpenClaw **filtert skills tijdens het laden** met `metadata` (éénregelig JSON):

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

Velden onder `metadata.openclaw`:

- `always: true` — altijd de skill opnemen (andere gates overslaan).
- `emoji` — optionele emoji gebruikt door de macOS Skills-UI.
- `homepage` — optionele URL die wordt getoond als “Website” in de macOS Skills-UI.
- `os` — optionele lijst met platforms (`darwin`, `linux`, `win32`). Indien ingesteld, is de skill alleen geldig op die OS’en.
- `requires.bins` — lijst; elk item moet bestaan op `PATH`.
- `requires.anyBins` — lijst; ten minste één moet bestaan op `PATH`.
- `requires.env` — lijst; env-var moet bestaan **of** via config worden aangeleverd.
- `requires.config` — lijst met `openclaw.json`-paden die truthy moeten zijn.
- `primaryEnv` — env-varnaam die is gekoppeld aan `skills.entries.<name>.apiKey`.
- `install` — optionele array met installer-specs die door de macOS Skills-UI worden gebruikt (brew/node/go/uv/download).

Opmerking over sandboxing:

- `requires.bins` wordt gecontroleerd op de **host** tijdens het laden van de skill.
- Als een agent gesandboxed is, moet de binary ook **in de container** aanwezig zijn.
  Installeer deze via `agents.defaults.sandbox.docker.setupCommand` (of een custom image).
  `setupCommand` wordt één keer uitgevoerd nadat de container is aangemaakt.
  Pakketinstallaties vereisen ook netwerk-egress, een beschrijfbaar root-FS en een root-gebruiker in de sandbox.
  Voorbeeld: de `summarize`-skill (`skills/summarize/SKILL.md`) heeft de `summarize` CLI
  in de sandboxcontainer nodig om daar te draaien.

Installer-voorbeeld:

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

Notities:

- Als meerdere installers zijn vermeld, kiest de Gateway **één** voorkeursoptie (brew indien beschikbaar, anders node).
- Als alle installers `download` zijn, toont OpenClaw elke invoer zodat je de beschikbare artefacten kunt zien.
- Installer-specs kunnen `os: ["darwin"|"linux"|"win32"]` bevatten om opties per platform te filteren.
- Node-installaties respecteren `skills.install.nodeManager` in `openclaw.json` (standaard: npm; opties: npm/pnpm/yarn/bun).
  Dit beïnvloedt alleen **skill-installaties**; de Gateway-runtime moet nog steeds Node zijn
  (Bun wordt niet aanbevolen voor WhatsApp/Telegram).
- Go-installaties: als `go` ontbreekt en `brew` beschikbaar is, installeert de Gateway eerst Go via Homebrew en stelt `GOBIN` in op Homebrew’s `bin` wanneer mogelijk.
- Download-installaties: `url` (vereist), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (standaard: auto wanneer archief wordt gedetecteerd), `stripComponents`, `targetDir` (standaard: `~/.openclaw/tools/<skillKey>`).

Als er geen `metadata.openclaw` aanwezig is, is de skill altijd geldig (tenzij
uitgeschakeld in config of geblokkeerd door `skills.allowBundled` voor gebundelde skills).

## Config-overschrijvingen (`~/.openclaw/openclaw.json`)

Gebundelde/beheerde skills kunnen worden in- of uitgeschakeld en van env-waarden worden voorzien:

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

Let op: als de skillnaam koppeltekens bevat, zet de sleutel tussen aanhalingstekens (JSON5 staat gequote sleutels toe).

Config-sleutels komen standaard overeen met de **skillnaam**. Als een skill
`metadata.openclaw.skillKey` definieert, gebruik die sleutel onder `skills.entries`.

Regels:

- `enabled: false` schakelt de skill uit, zelfs als deze gebundeld/geïnstalleerd is.
- `env`: wordt **alleen geïnjecteerd** als de variabele nog niet in het proces is ingesteld.
- `apiKey`: gemak voor skills die `metadata.openclaw.primaryEnv` declareren.
- `config`: optionele verzamelmap voor aangepaste per-skill-velden; custom sleutels moeten hier staan.
- `allowBundled`: optionele toegestane lijst voor **alleen gebundelde** skills. Indien ingesteld, zijn alleen
  gebundelde skills in de lijst geldig (beheerde/werkruimte-skills blijven onaangetast).

## Omgevingsinjectie (per agent-run)

Wanneer een agent-run start, doet OpenClaw het volgende:

1. Leest skill-metadata.
2. Past eventuele `skills.entries.<key>.env` of `skills.entries.<key>.apiKey` toe op
   `process.env`.
3. Bouwt de systeemprompt met **geldige** skills.
4. Herstelt de oorspronkelijke omgeving nadat de run eindigt.

Dit is **afgebakend tot de agent-run**, geen globale shell-omgeving.

## Sessie-snapshot (prestaties)

OpenClaw maakt een snapshot van de geldige skills **wanneer een sessie start** en hergebruikt die lijst voor volgende beurten in dezelfde sessie. Wijzigingen aan skills of config worden van kracht bij de volgende nieuwe sessie.

Skills kunnen ook midden in een sessie verversen wanneer de skills-watcher is ingeschakeld of wanneer een nieuwe geldige remote node verschijnt (zie hieronder). Zie dit als een **hot reload**: de ververste lijst wordt opgepikt bij de volgende agentbeurt.

## Remote macOS-nodes (Linux Gateway)

Als de Gateway op Linux draait maar een **macOS-node** is verbonden **met `system.run` toegestaan** (Exec approvals-beveiliging niet ingesteld op `deny`), kan OpenClaw macOS-only skills als geldig behandelen wanneer de vereiste binaries op die node aanwezig zijn. De agent moet die skills uitvoeren via de `nodes`-tool (meestal `nodes.run`).

Dit vertrouwt op het rapporteren van commando-ondersteuning door de node en op een bin-probe via `system.run`. Als de macOS-node later offline gaat, blijven de skills zichtbaar; aanroepen kunnen mislukken totdat de node opnieuw verbindt.

## Skills-watcher (auto-verversen)

Standaard bewaakt OpenClaw skill-mappen en verhoogt de skills-snapshot wanneer `SKILL.md`-bestanden wijzigen. Configureer dit onder `skills.load`:

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

## Token-impact (skills-lijst)

Wanneer skills geldig zijn, injecteert OpenClaw een compacte XML-lijst van beschikbare skills in de systeemprompt (via `formatSkillsForPrompt` in `pi-coding-agent`). De kosten zijn deterministisch:

- **Basisoverhead (alleen wanneer ≥1 skill):** 195 tekens.
- **Per skill:** 97 tekens + de lengte van de XML-geëscapete `<name>`, `<description>` en `<location>`-waarden.

Formule (tekens):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Notities:

- XML-escaping zet `& < > " '` om in entiteiten (`&amp;`, `&lt;`, enz.), wat de lengte vergroot.
- Tokentellingen variëren per modeltokenizer. Een ruwe OpenAI-achtige schatting is ~4 tekens/token, dus **97 tekens ≈ 24 tokens** per skill plus je daadwerkelijke veldlengtes.

## Levenscyclus van beheerde skills

OpenClaw levert een basisset skills als **gebundelde skills** als onderdeel van de
installatie (npm-pakket of OpenClaw.app). `~/.openclaw/skills` bestaat voor lokale
overrides (bijvoorbeeld het vastpinnen/patchen van een skill zonder de gebundelde
kopie te wijzigen). Werkruimte-skills zijn eigendom van de gebruiker en overrulen
beide bij naamconflicten.

## Config-referentie

Zie [Skills config](/tools/skills-config) voor het volledige configuratieschema.

## Op zoek naar meer skills?

Blader op [https://clawhub.com](https://clawhub.com).

---
