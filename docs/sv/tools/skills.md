---
summary: "Skills: hanterade vs arbetsyta, spärrregler och konfig-/env-koppling"
read_when:
  - Lägga till eller ändra skills
  - Ändra spärrning eller laddningsregler för skills
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw använder **[AgentSkills](https://agentskills.io)-kompatibel** kunskapsmappar för att lära agenten hur man använder verktyg. Varje färdighet är en katalog som innehåller en `SKILL.md` med YAML frontmatter och instruktioner. OpenClaw laddar **buntade färdigheter** plus valfria lokala åsidosättningar och filtrerar dem vid laddningstid baserat på miljö, konfigurering och binär närvaro.

## Platser och prioritet

Skills laddas från **tre** platser:

1. **Bundlade skills**: levereras med installationen (npm-paket eller OpenClaw.app)
2. **Hanterade/lokala skills**: `~/.openclaw/skills`
3. **Workspace-skills**: `<workspace>/skills`

Om ett skill-namn krockar är prioriteten:

`<workspace>/skills` (högst) → `~/.openclaw/skills` → bundlade skills (lägst)

Dessutom kan du konfigurera extra skill-mappar (lägsta prioritet) via
`skills.load.extraDirs` i `~/.openclaw/openclaw.json`.

## Per-agent vs delade skills

I **multi-agent** setups, har varje agent sin egen arbetsyta. Det betyder:

- **Per-agent-skills** finns i `<workspace>/skills` endast för den agenten.
- **Delade skills** finns i `~/.openclaw/skills` (hanterade/lokala) och är synliga
  för **alla agenter** på samma maskin.
- **Delade mappar** kan också läggas till via `skills.load.extraDirs` (lägsta
  prioritet) om du vill ha ett gemensamt skill-paket som används av flera agenter.

Om samma skill-namn finns på mer än ett ställe gäller den vanliga prioriteten:
workspace vinner, sedan hanterade/lokala, därefter bundlade.

## Plugins + skills

Plugins kan skicka sina egna färdigheter genom att ange `skills`-kataloger i
`openclaw.plugin.json` (sökvägar i förhållande till plugin-root). Plugin färdigheter ladda
när plugin är aktiverad och delta i den normala skicklighet företrädesregler.
Du kan grinda dem via `metadata.openclaw.requires.config` på plugins config
post. Se [Plugins](/tools/plugin) för upptäckt/config och [Tools](/tools) för
verktygets yta dessa färdigheter lär.

## ClawHub (installera + synka)

ClawHub är det offentliga kompetensregistret för OpenClaw. Bläddra på
[https://clawhub.com](https://clawhub.com). Använd den för att upptäcka, installera, uppdatera och säkerhetskopiera färdigheter.
Fullständig guide: [ClawHub](/tools/clawhub).

Vanliga flöden:

- Installera en skill i din workspace:
  - `clawhub install <skill-slug>`
- Uppdatera alla installerade skills:
  - `clawhub update --all`
- Synka (skanna + publicera uppdateringar):
  - `clawhub sync --all`

Som standard installerar `clawhub` i `./skills` under din nuvarande arbetskatalog
(eller faller tillbaka till den konfigurerade arbetsytan för OpenClaw). OpenClaw plockar
upp det som `<workspace>/skills` på nästa session.

## Säkerhetsnoteringar

- Behandla tredjepartskunskaper som **opålitlig kod**. Läs dem innan du aktiverar.
- Föredrar sandlåda körs för opålitliga ingångar och riskabla verktyg. Se [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` och `skills.entries.*.apiKey` injicera hemligheter i **värd** processen
  för den agenten tur (inte sandlådan). Håll hemligheter utanför förfrågningar och loggar.
- För en bredare hotmodell och checklistor, se [Security](/gateway/security).

## Format (AgentSkills + Pi-kompatibelt)

`SKILL.md` måste minst innehålla:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Noteringar:

- Vi följer AgentSkills-specifikationen för layout/avsikt.
- Parsern som används av den inbäddade agenten stöder endast **enradiga** frontmatter-nycklar.
- `metadata` ska vara ett **enradigt JSON-objekt**.
- Använd `{baseDir}` i instruktioner för att referera till skill-mappens sökväg.
- Valfria frontmatter-nycklar:
  - `homepage` — URL som visas som ”Website” i macOS Skills-UI:t (stöds även via `metadata.openclaw.homepage`).
  - `user-invocable` — `true<unk> false` (standard: `true`). När `true`, är skickligheten exponeras som ett användarsnedstreck kommando.
  - `disable-model-invocation` — `true<unk> false` (standard: `false`). När `true`, är skickligheten exkluderad från modellprompten (fortfarande tillgänglig via användaranrop).
  - `command-dispatch` - `tool` (valfritt). När satt till `tool`, förbigår slash-kommandot modellen och skickar direkt till ett verktyg.
  - `command-tool` — verktygsnamn att anropa när `command-dispatch: tool` är satt.
  - `command-arg-mode` — `raw` (standard). För verktygsavsändande vidarebefordrar råvarans sträng till verktyget (ingen kärnskärning).

    Verktyget anropas med parametrar:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Spärrning (filter vid laddning)

OpenClaw **filtrerar skills vid laddning** med `metadata` (enradigt JSON):

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

Fält under `metadata.openclaw`:

- `always: true` — inkludera alltid skillen (hoppa över andra spärrar).
- `emoji` — valfri emoji som används av macOS Skills-UI:t.
- `homepage` — valfri URL som visas som ”Website” i macOS Skills-UI:t.
- `os` - valfri lista över plattformar (`darwin`, `linux`, `win32`). Om angivet, är skickligheten endast berättigad till dessa OS.
- `requires.bins` — lista; var och en måste finnas på `PATH`.
- `requires.anyBins` — lista; minst en måste finnas på `PATH`.
- `requires.env` — lista; env-var måste finnas **eller** tillhandahållas i konfig.
- `requires.config` — lista med `openclaw.json`-sökvägar som måste vara truthy.
- `primaryEnv` — env var name associerat med `skills.entries.<name>.apiKey`.
- `install` — valfri array av installerarspecifikationer som används av macOS Skills-UI:t (brew/node/go/uv/download).

Not om sandboxing:

- `requires.bins` kontrolleras på **värden** vid skill-laddning.
- Om en agent är sandlåda måste binären också finnas **inuti behållaren**.
  Installera den via `agents.defaults.sandbox.docker.setupCommand` (eller en anpassad bild).
  `setupCommand` körs en gång efter att behållaren skapats.
  Paketinstallationer kräver även nätverksinställningar, en skrivbar root FS, och en root-användare i sandlådan.
  Exempel: `summarize` -skicklighet (`skills/summarize/SKILL.md`) behöver `summarize` CLI
  i sandlådan för att köras där.

Exempel på installerare:

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

Noteringar:

- Om flera installerare listas väljer gatewayen **ett** föredraget alternativ (brew när tillgängligt, annars node).
- Om alla installerare är `download` listar OpenClaw varje post så att du kan se tillgängliga artefakter.
- Installerarspecifikationer kan inkludera `os: ["darwin"|"linux"|"win32"]` för att filtrera alternativ per plattform.
- Node installerar honor `skills.install.nodeManager` i `openclaw.json` (standard: npm; alternativ: npm/pnpm/yarn/bun).
  Detta påverkar endast **färdighetsinstallationer**; Gateway runtime bör fortfarande vara Node
  (Bun rekommenderas inte för WhatsApp/Telegram).
- Go-installationer: om `go` saknas och `brew` finns installerar gatewayen först Go via Homebrew och sätter `GOBIN` till Homebrews `bin` när möjligt.
- Nedladdningsinstallationer: `url` (krävs), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (standard: auto när arkiv upptäcks), `stripComponents`, `targetDir` (standard: `~/.openclaw/tools/<skillKey>`).

Om ingen `metadata.openclaw` finns är skillen alltid giltig (om den inte
inaktiveras i konfig eller blockeras av `skills.allowBundled` för bundlade skills).

## Konfig-åsidosättningar (`~/.openclaw/openclaw.json`)

Bundlade/hanterade skills kan slås på/av och förses med env-värden:

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

Obs: om skill-namnet innehåller bindestreck, citera nyckeln (JSON5 tillåter citerade nycklar).

Konfigurationsnycklar matchar **skicklighetsnamn** som standard. Om en färdighet definierar
`metadata.openclaw.skillKey`, använd den nyckeln under `skills.entries`.

Regler:

- `enabled: false` inaktiverar skillen även om den är bundlad/installerad.
- `env`: injiceras **endast om** variabeln inte redan är satt i processen.
- `apiKey`: bekvämlighet för skills som deklarerar `metadata.openclaw.primaryEnv`.
- `config`: valfri påse för anpassade per-skill-fält; anpassade nycklar måste ligga här.
- `allowBundled`: valfri tillåten lista för **bundna** färdigheter endast. Om angivet, är endast
  medföljande färdigheter i listan berättigade (hanterade / arbetsytor opåverkade).

## Miljöinjektion (per agentkörning)

När en agentkörning startar gör OpenClaw:

1. Läser skill-metadata.
2. Tillämpar alla `skills.entries.<key>.env` eller `skills.entries.<key>.apiKey` till
   `process.env`.
3. Bygger systemprompten med **giltiga** skills.
4. Återställer den ursprungliga miljön efter att körningen avslutats.

Detta är **avgränsat till agentkörningen**, inte en global skalmiljö.

## Sessionssnapshot (prestanda)

OpenClaw ögonblicksbilder den kvalificerade kompetensen **när en session startar** och återanvänder den listan för efterföljande svängar i samma session. Förändringar i kompetens eller konfiguration träder i kraft på nästa nya session.

Färdigheter kan också uppdatera mitt i sessionen när kompetensbevakaren är aktiverad eller när en ny kvalificerad fjärrnod visas (se nedan). Tänk på detta som en **het reload**: den uppdaterade listan plockas upp på nästa agent turn.

## Fjärr-macOS-noder (Linux-gateway)

Om Gateway körs på Linux men en **macOS node** är ansluten **med `system. un` tillåtet** (Exec godkänner inte säkerhet satt till `deny`), OpenClaw kan behandla macOS-endast färdigheter som berättigade när de nödvändiga binärerna finns på den noden. Agenten bör utföra dessa färdigheter via `nodes`-verktyget (typiskt `nodes.run`).

Detta förlitar sig på noden som rapporterar sitt kommandoradsstöd och på en bin sond via `system.run`. Om macOS-noden går offline senare förblir färdigheterna synliga; anrop kan misslyckas tills noden återansluts.

## Skills watcher (automatisk uppdatering)

Som standard tittar OpenClaw på skicklighetsmappar och stöter på kompetensögonblicksbilden när `SKILL.md`-filer ändras. Konfigurera detta under `skills.load`:

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

## Tokenpåverkan (skills-lista)

När kompetens är berättigad injicerar OpenClaw en kompakt XML-lista över tillgängliga färdigheter i systemprompten (via `formatSkillsForPrompt` i `pi-coding-agent`). Kostnaden är deterministisk:

- **Basöverhead (endast när ≥1 skill):** 195 tecken.
- **Per skill:** 97 tecken + längden på de XML-escapade `<name>`, `<description>` och `<location>`-värdena.

Formel (tecken):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Noteringar:

- XML-escaping expanderar `& < > " '` till entiteter (`&amp;`, `&lt;`, etc.), vilket ökar längden.
- Token räknas varierar beroende på modell tokenizer. En grov OpenAI-stil uppskattning är ~4 chars/token, så **97 chars ▸ 24 tokens** per skicklighet plus dina faktiska fältlängder.

## Livscykel för hanterade skills

OpenClaw levererar en uppsättning färdigheter som **buntade färdigheter** som en del av installationen
(npm package eller OpenClaw.app). `~/.openclaw/skills` finns för lokala
åsidosättningar (till exempel fast/patchar en färdighet utan att ändra den medföljande
kopian). Arbetsytans färdigheter är användarägda och åsidosätter båda namnkonflikter.

## Konfigreferens

Se [Skills config](/tools/skills-config) för det fullständiga konfigurationsschemat.

## Letar du efter fler skills?

Bläddra på [https://clawhub.com](https://clawhub.com).

---
