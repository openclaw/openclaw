---
summary: "Skills: administrerede vs. workspace, gate-regler og config/env-kobling"
read_when:
  - Tilføjelse eller ændring af skills
  - Ændring af skill-gating eller indlæsningsregler
title: "Skills"
x-i18n:
  source_path: tools/skills.md
  source_hash: 70d7eb9e422c17a4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:03Z
---

# Skills (OpenClaw)

OpenClaw bruger **[AgentSkills](https://agentskills.io)-kompatible** skill-mapper til at lære agenten at bruge værktøjer. Hver skill er en mappe, der indeholder en `SKILL.md` med YAML-frontmatter og instruktioner. OpenClaw indlæser **bundled skills** plus valgfrie lokale overrides og filtrerer dem ved indlæsning baseret på miljø, konfiguration og tilstedeværelse af binærer.

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

I **multi-agent**-opsætninger har hver agent sit eget workspace. Det betyder:

- **Per-agent skills** ligger i `<workspace>/skills` kun for den agent.
- **Delte skills** ligger i `~/.openclaw/skills` (managed/local) og er synlige
  for **alle agenter** på samme maskine.
- **Delte mapper** kan også tilføjes via `skills.load.extraDirs` (laveste
  prioritet), hvis du vil have en fælles skill-pakke brugt af flere agenter.

Hvis det samme skill-navn findes flere steder, gælder den normale prioritet:
workspace vinder, derefter managed/local og til sidst bundled.

## Plugins + skills

Plugins kan levere deres egne skills ved at angive `skills`-mapper i
`openclaw.plugin.json` (stier relative til plugin-roden). Plugin-skills indlæses,
når plugin’et er aktiveret, og deltager i de normale prioriteringsregler for skills.
Du kan gate dem via `metadata.openclaw.requires.config` på plugin’ets konfigurationspost.
Se [Plugins](/tools/plugin) for discovery/konfiguration og [Tools](/tools) for den
værktøjsflade, som disse skills underviser i.

## ClawHub (installation + synk)

ClawHub er det offentlige skills-register for OpenClaw. Gennemse på
[https://clawhub.com](https://clawhub.com). Brug det til at opdage, installere, opdatere og sikkerhedskopiere skills.
Fuld guide: [ClawHub](/tools/clawhub).

Almindelige flows:

- Installér et skill i dit workspace:
  - `clawhub install <skill-slug>`
- Opdatér alle installerede skills:
  - `clawhub update --all`
- Synk (scan + udgiv opdateringer):
  - `clawhub sync --all`

Som standard installerer `clawhub` i `./skills` under din aktuelle
arbejdsmappe (eller falder tilbage til det konfigurerede OpenClaw-workspace).
OpenClaw opfanger dette som `<workspace>/skills` ved næste session.

## Sikkerhedsnoter

- Behandl tredjeparts-skills som **utroværdig kode**. Læs dem, før du aktiverer dem.
- Foretræk sandboxed kørsel for utroværdige input og risikable værktøjer. Se [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` og `skills.entries.*.apiKey` injicerer hemmeligheder i **host**-processen
  for den agent-tur (ikke i sandboxen). Hold hemmeligheder ude af prompts og logs.
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
  - `user-invocable` — `true|false` (standard: `true`). Når `true`, eksponeres skill’et som en bruger slash-kommando.
  - `disable-model-invocation` — `true|false` (standard: `false`). Når `true`, udelukkes skill’et fra modelprompten (stadig tilgængeligt via brugerinvokation).
  - `command-dispatch` — `tool` (valgfrit). Når sat til `tool`, omgår slash-kommandoen modellen og dispatcher direkte til et værktøj.
  - `command-tool` — værktøjsnavn, der skal kaldes, når `command-dispatch: tool` er sat.
  - `command-arg-mode` — `raw` (standard). For værktøjsdispatch videresendes den rå args-streng til værktøjet (ingen core-parsing).

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
- `os` — valgfri liste over platforme (`darwin`, `linux`, `win32`). Hvis sat, er skill’et kun berettiget på disse OS’er.
- `requires.bins` — liste; hver skal findes på `PATH`.
- `requires.anyBins` — liste; mindst én skal findes på `PATH`.
- `requires.env` — liste; env-var skal findes **eller** være angivet i konfigurationen.
- `requires.config` — liste over `openclaw.json`-stier, der skal være truthy.
- `primaryEnv` — env-var-navn associeret med `skills.entries.<name>.apiKey`.
- `install` — valgfrit array af installer-specifikationer brugt af macOS Skills UI (brew/node/go/uv/download).

Note om sandboxing:

- `requires.bins` kontrolleres på **hosten** ved indlæsning af skill’et.
- Hvis en agent er sandboxed, skal binæren også findes **inde i containeren**.
  Installér den via `agents.defaults.sandbox.docker.setupCommand` (eller et custom image).
  `setupCommand` kører én gang efter, at containeren er oprettet.
  Pakkeinstallationer kræver også netværks-egress, et skrivbart root-filsystem og en root-bruger i sandboxen.
  Eksempel: `summarize`-skill’et (`skills/summarize/SKILL.md`) kræver `summarize` CLI
  i sandbox-containeren for at køre der.

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
- Node-installationer respekterer `skills.install.nodeManager` i `openclaw.json` (standard: npm; muligheder: npm/pnpm/yarn/bun).
  Dette påvirker kun **skill-installationer**; Gateway-runtime bør stadig være Node
  (Bun anbefales ikke til WhatsApp/Telegram).
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

Konfigurationsnøgler matcher som standard **skill-navnet**. Hvis et skill definerer
`metadata.openclaw.skillKey`, brug den nøgle under `skills.entries`.

Regler:

- `enabled: false` deaktiverer skill’et, selv hvis det er bundled/installeret.
- `env`: injiceres **kun hvis** variablen ikke allerede er sat i processen.
- `apiKey`: bekvemmelighed for skills, der deklarerer `metadata.openclaw.primaryEnv`.
- `config`: valgfri pose til brugerdefinerede per-skill-felter; brugerdefinerede nøgler skal ligge her.
- `allowBundled`: valgfri tilladelsesliste kun for **bundled** skills. Hvis sat, er kun
  bundled skills på listen berettigede (managed/workspace skills er upåvirkede).

## Miljøinjektion (per agent-kørsel)

Når en agent-kørsel starter, gør OpenClaw følgende:

1. Læser skill-metadata.
2. Anvender eventuelle `skills.entries.<key>.env` eller `skills.entries.<key>.apiKey` på
   `process.env`.
3. Opbygger systemprompten med **berettigede** skills.
4. Gendanner det oprindelige miljø, efter at kørslen er slut.

Dette er **afgrænset til agent-kørslen**, ikke et globalt shell-miljø.

## Sessions-snapshot (performance)

OpenClaw tager et snapshot af de berettigede skills **når en session starter** og genbruger den liste for efterfølgende ture i samme session. Ændringer i skills eller konfiguration træder i kraft ved næste nye session.

Skills kan også opdateres midt i en session, når skills-watcher er aktiveret, eller når en ny berettiget fjernnode dukker op (se nedenfor). Tænk på dette som et **hot reload**: den opdaterede liste bruges ved næste agent-tur.

## Fjern-macOS-noder (Linux-gateway)

Hvis Gateway kører på Linux, men en **macOS-node** er forbundet **med `system.run` tilladt** (Exec approvals-sikkerhed ikke sat til `deny`), kan OpenClaw behandle macOS-only skills som berettigede, når de nødvendige binærer findes på den node. Agenten bør udføre disse skills via `nodes`-værktøjet (typisk `nodes.run`).

Dette afhænger af, at noden rapporterer sin kommando-understøttelse og af en bin-probe via `system.run`. Hvis macOS-noden senere går offline, forbliver skills synlige; kald kan fejle, indtil noden genforbinder.

## Skills-watcher (auto-opdatering)

Som standard overvåger OpenClaw skill-mapper og opdaterer skills-snapshot’et, når `SKILL.md`-filer ændres. Konfigurer dette under `skills.load`:

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

Når skills er berettigede, injicerer OpenClaw en kompakt XML-liste over tilgængelige skills i systemprompten (via `formatSkillsForPrompt` i `pi-coding-agent`). Omkostningen er deterministisk:

- **Basis-overhead (kun når ≥1 skill):** 195 tegn.
- **Per skill:** 97 tegn + længden af de XML-escaped `<name>`, `<description>` og `<location>`-værdier.

Formel (tegn):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Noter:

- XML-escaping udvider `& < > " '` til entiteter (`&amp;`, `&lt;`, osv.), hvilket øger længden.
- Tokenantal varierer efter model-tokenizer. Et groft OpenAI-agtigt estimat er ~4 tegn/token, så **97 tegn ≈ 24 tokens** pr. skill plus dine faktiske feltlængder.

## Livscyklus for managed skills

OpenClaw leverer et basissæt af skills som **bundled skills** som en del af
installationen (npm-pakke eller OpenClaw.app). `~/.openclaw/skills` findes til lokale
overrides (f.eks. fastlåsning/patching af et skill uden at ændre den bundled
kopi). Workspace skills er bruger-ejede og overstyrer begge ved navnekonflikter.

## Konfigurationsreference

Se [Skills config](/tools/skills-config) for det fulde konfigurationsskema.

## Leder du efter flere skills?

Gennemse [https://clawhub.com](https://clawhub.com).

---
