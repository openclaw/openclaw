---
summary: "Skills: administrerede vs. workspace, gate-regler og config/env-kobling"
read_when:
  - Tilføjelse eller ændring af skills
  - Ændring af skill-gating eller indlæsningsregler
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw bruger **[AgentSkills](https://agentskills.io)-kompatible** færdighedsmapper til at lære agenten hvordan man bruger værktøjer. Hver færdighed er en mappe, der indeholder en `SKILL.md` med YAML frontmatter og instruktioner. OpenClaw belastninger **bundtede færdigheder** plus valgfri lokale overskrivninger, og filtrerer dem på belastningstidspunktet baseret på miljø, config og binær tilstedeværelse.

## Placeringer og prioritet

Skills indlæses fra **tre** steder:

1. **Bundled skills**: leveret med installationen (npm-pakke eller OpenClaw.app)
2. **Managed/local skills**: `~/.openclaw/skills`
3. **Workspace skills**: `<workspace>/skills`

Hvis et skill-navn konflikter, er prioriteten:

`<workspace>/skills` (højeste) → `~/.openclaw/skills` → bundled skills (laveste)

Derudover kan du konfigurere ekstra skill-mapper (laveste prioritet) via
`skills.load.extraDirs` i `~/.openclaw/openclaw.json`.

## Per-agent vs. delte skills

I **multi-agent** opsætninger, hver agent har sit eget arbejdsområde. Det betyder:

- **Per-agent skills** ligger i `<workspace>/skills` kun for den agent.
- **Delte skills** ligger i `~/.openclaw/skills` (managed/local) og er synlige
  for **alle agenter** på samme maskine.
- **Delte mapper** kan også tilføjes via `skills.load.extraDirs` (laveste
  prioritet), hvis du vil have en fælles skill-pakke brugt af flere agenter.

Hvis det samme skill-navn findes flere steder, gælder den normale prioritet:
workspace vinder, derefter managed/local og til sidst bundled.

## Plugins + skills

Plugins kan sende deres egne færdigheder ved at notere `færdigheder` mapper i
`openclaw.plugin.json` (stier i forhold til plugin root). Plugin færdigheder indlæse
, når plugin'et er aktiveret og deltage i de normale regler for dygtighed forrang.
Du kan gate dem via `metadata.openclaw.requires.config` på plugin ‘ s config
post. Se [Plugins](/tools/plugin) for opdagelse/konfiguration og [Tools](/tools) for værktøjsfladen, som disse skills lærer.

## ClawHub (installation + synk)

ClawHub er registret over offentlige færdigheder for OpenClaw. Gennemse på
[https://clawhub.com](https://clawhub.com). Brug den til at opdage, installere, opdatere og sikkerhedskopiere færdigheder.
Fuld guide: [ClawHub](/tools/clawhub).

Almindelige flows:

- Installér et skill i dit workspace:
  - `clawhub install <skill-slug>`
- Opdatér alle installerede skills:
  - `clawhub update --all`
- Synk (scan + udgiv opdateringer):
  - `clawhub sync --all`

Som standard installeres `clawhub` i `./skills` under din nuværende fungerende
mappe (eller falder tilbage til det konfigurerede OpenClaw arbejdsområde). OpenClaw henter
der op som `<workspace>/skills` på den næste session.

## Sikkerhedsnoter

- Behandl tredjepartskvalifikationer som **ikke-betroet kode**. Læs dem, før du aktiverer.
- Foretræk sandkasse kørsler for upålidelige indgange og risikable værktøjer. Se [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` og `skills.entries.*.apiKey` injicerer hemmeligheder i **vært**processen
  for den pågældende agent slå (ikke sandkassen). Hold hemmeligheder ude af prompter og logs.
- For en bredere trusselsmodel og tjeklister, se [Security](/gateway/security).

## Format (AgentSkills + Pi-kompatibel)

`SKILL.md` skal som minimum indeholde:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Noter:

- Vi følger AgentSkills-specifikationen for layout/intention.
- Parseren, som bruges af den indlejrede agent, understøtter kun **single-line** frontmatter-nøgler.
- `metadata` skal være et **single-line JSON-objekt**.
- Brug `{baseDir}` i instruktioner til at referere til skill-mappens sti.
- Valgfrie frontmatter-nøgler:
  - `homepage` — URL vist som “Website” i macOS Skills UI (også understøttet via `metadata.openclaw.homepage`).
  - `user-invocable` — `trueřfalse` (standard: `true`). Når `true`, færdigheder er udsat som en bruger skråstreg kommando.
  - `disable-model-invocation` — `true¤ false` (standard: `false`). Når `true`, færdigheder er udelukket fra model prompt (stadig tilgængelig via bruger påkaldelse).
  - `command-dispatch` — `tool` (valgfrit). Når sat til `tool`, skråstregen kommando omgår modellen og afsender direkte til et værktøj.
  - `command-tool` — værktøjsnavn, der skal kaldes, når `command-dispatch: tool` er sat.
  - `command-arg-mode` — `raw` (standard). For værktøj afsendelse sender den rå args streng til værktøjet (ingen core parsing).

    Værktøjet kaldes med parametre:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Gating (filtre ved indlæsning)

OpenClaw **filtrerer skills ved indlæsning** ved hjælp af `metadata` (single-line JSON):

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

Felter under `metadata.openclaw`:

- `always: true` — inkluder altid skill’et (spring andre gates over).
- `emoji` — valgfri emoji brugt af macOS Skills UI.
- `homepage` — valgfri URL vist som “Website” i macOS Skills UI.
- `os` — valgfri liste over platforme (`darwin`, `linux`, `win32`). Hvis angivet, er færdigheden kun berettiget på disse styresystemer.
- `requires.bins` — liste; hver skal findes på `PATH`.
- `requires.anyBins` — liste; mindst én skal findes på `PATH`.
- `requires.env` — liste; env-var skal findes **eller** være angivet i konfigurationen.
- `requires.config` — liste over `openclaw.json`-stier, der skal være truthy.
- `primaryEnv` — env var navn forbundet med `skills.entries.<name>.apiKey`.
- `install` — valgfrit array af installer-specifikationer brugt af macOS Skills UI (brew/node/go/uv/download).

Note om sandboxing:

- `requires.bins` kontrolleres på **hosten** ved indlæsning af skill’et.
- Hvis en agent er sandboxed, skal den binære skal også eksistere **inde i beholderen**.
  Installere det via `agents.defaults.sandbox.docker.setupCommand` (eller et brugerdefineret billede).
  `setupCommand` kører én gang efter beholderen er oprettet.
  Pakken installerer også kræver netværk egress, en skrivbar root FS, og en root bruger i sandkassen.
  Eksempel: 'summariser' færdighed ('færdigheder/opsummering/SKILL.md') har brug for 'summariser' CLI
  i sandkassebeholderen til at køre der.

Installer-eksempel:

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

Noter:

- Hvis der er angivet flere installere, vælger gatewayen én **enkelt** foretrukken mulighed (brew når tilgængelig, ellers node).
- Hvis alle installere er `download`, viser OpenClaw hver post, så du kan se de tilgængelige artefakter.
- Installer-specifikationer kan inkludere `os: ["darwin"|"linux"|"win32"]` for at filtrere muligheder efter platform.
- Node installerer honor `skills.install.nodeManager` i `openclaw.json` (standard: npm; muligheder: npm/pnpm/yarn/bun).
  Dette påvirker kun **færdighed installerer**; Gateway runtime skal stadig være node
  (Bun anbefales ikke for WhatsApp/Telegram).
- Go-installationer: hvis `go` mangler og `brew` er tilgængelig, installerer gatewayen først Go via Homebrew og sætter `GOBIN` til Homebrews `bin`, når det er muligt.
- Download-installationer: `url` (påkrævet), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (standard: auto når arkiv registreres), `stripComponents`, `targetDir` (standard: `~/.openclaw/tools/<skillKey>`).

Hvis der ikke er angivet nogen `metadata.openclaw`, er skill’et altid berettiget (medmindre
det er deaktiveret i konfigurationen eller blokeret af `skills.allowBundled` for bundled skills).

## Konfigurations-overrides (`~/.openclaw/openclaw.json`)

Bundled/managed skills kan slås til/fra og forsynes med env-værdier:

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

Bemærk: hvis skill-navnet indeholder bindestreger, så citer nøglen (JSON5 tillader citerede nøgler).

Konfigurationstaster matcher som standard **dygtighedsnavn**. Hvis en færdighed definerer
`metadata.openclaw.skillKey`, brug denne nøgle under `skills.entries`.

Regler:

- `enabled: false` deaktiverer skill’et, selv hvis det er bundled/installeret.
- `env`: injiceres **kun hvis** variablen ikke allerede er sat i processen.
- `apiKey`: bekvemmelighed for skills, der deklarerer `metadata.openclaw.primaryEnv`.
- `config`: valgfri pose til brugerdefinerede per-skill-felter; brugerdefinerede nøgler skal ligge her.
- `allowBundled`: valgfri tilladt liste for \*\*bundtede \*\* færdigheder. Hvis angivet, kun
  bundtede færdigheder på listen er kvalificerede (administrerede/arbejdsområde færdigheder upåvirket).

## Miljøinjektion (per agent-kørsel)

Når en agent-kørsel starter, gør OpenClaw følgende:

1. Læser skill-metadata.
2. Gælder alle `skills.entries.<key>.env` eller `skills.entries.<key>.apiKey` til
   `process.env`.
3. Opbygger systemprompten med **berettigede** skills.
4. Gendanner det oprindelige miljø, efter at kørslen er slut.

Dette er **afgrænset til agent-kørslen**, ikke et globalt shell-miljø.

## Sessions-snapshot (performance)

OpenClaw snapshots de kvalificerede færdigheder **når en session starter** og genbruger denne liste til efterfølgende sving i samme session. Ændringer af færdigheder eller config træder i kraft på den næste nye session.

Færdigheder kan også opdatere midten af sessionen, når færdighedswatcher er aktiveret, eller når en ny kvalificeret fjernbetjening vises (se nedenfor). Tænk på dette som en **varm genindlæsning**: den opdaterede liste hentes på næste agent tur.

## Fjern-macOS-noder (Linux-gateway)

Hvis Gateway kører på Linux, men et **macOS node** er forbundet **med `system. un` tilladt** (Exec godkendelser sikkerhed ikke indstillet til `benægt`), OpenClaw kan behandle macOS-kun færdigheder som kvalificerede, når de krævede binære filer er til stede på den pågældende node. Agenten bør udføre disse færdigheder via `noder`-værktøjet (typisk `nodes.run`).

Dette er baseret på node rapportering sin kommando støtte og en bin sonde via `system.run`. Hvis macOS node går offline senere, de færdigheder forbliver synlige; påberåbelser kan mislykkes, indtil noden genoprettes.

## Skills-watcher (auto-opdatering)

Som standard overvåger OpenClaw færdigheder mapper og bump færdigheder snapshot når `SKILL.md` filer ændres. Konfigurer dette under `skills.load`:

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

## Token-påvirkning (skills-liste)

Når færdigheder er kvalificeret, OpenClaw tilfører en kompakt XML-liste over tilgængelige færdigheder i systemet prompt (via `formatSkillsForPrompt` i `pi-kodning-agent`). Omkostningerne er målret:

- **Basis-overhead (kun når ≥1 skill):** 195 tegn.
- **Per skill:** 97 tegn + længden af de XML-escaped `<name>`, `<description>` og `<location>`-værdier.

Formel (tegn):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Noter:

- XML-escaping udvider `& < > " '` til entiteter (`&amp;`, `&lt;`, osv.), hvilket øger længden.
- Token antal varierer efter model tokenizer. Et groft estimat i OpenAI-stil er ~4 tegn/token, så **97 tegn ≈ 24 tokens** pr. færdighed plus dine faktiske feltlængder.

## Livscyklus for managed skills

OpenClaw leverer et basissæt af færdigheder som **bundtede færdigheder** som en del af
installere (npm pakke eller OpenClaw.app). `~/.openclaw/skills` findes for lokale
tilsidesættelser (for eksempel pinning/lappe en dygtighed uden at ændre den medfølgende
-kopi). Arbejdspladsfærdigheder er brugerejede og tilsidesætter både på navnekonflikter.

## Konfigurationsreference

Se [Skills config](/tools/skills-config) for det fulde konfigurationsskema.

## Leder du efter flere skills?

Gennemse [https://clawhub.com](https://clawhub.com).

---
