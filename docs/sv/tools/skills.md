---
summary: "Skills: hanterade vs arbetsyta, spärrregler och konfig-/env-koppling"
read_when:
  - Lägga till eller ändra skills
  - Ändra spärrning eller laddningsregler för skills
title: "Skills"
x-i18n:
  source_path: tools/skills.md
  source_hash: 70d7eb9e422c17a4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:19:06Z
---

# Skills (OpenClaw)

OpenClaw använder **[AgentSkills](https://agentskills.io)-kompatibla** skill-mappar för att lära agenten hur verktyg används. Varje skill är en katalog som innehåller `SKILL.md` med YAML-frontmatter och instruktioner. OpenClaw laddar **bundlade skills** plus valfria lokala åsidosättningar och filtrerar dem vid laddning baserat på miljö, konfig och binärers närvaro.

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

I **multi-agent**-uppsättningar har varje agent sin egen arbetsyta. Det innebär:

- **Per-agent-skills** finns i `<workspace>/skills` endast för den agenten.
- **Delade skills** finns i `~/.openclaw/skills` (hanterade/lokala) och är synliga
  för **alla agenter** på samma maskin.
- **Delade mappar** kan också läggas till via `skills.load.extraDirs` (lägsta
  prioritet) om du vill ha ett gemensamt skill-paket som används av flera agenter.

Om samma skill-namn finns på mer än ett ställe gäller den vanliga prioriteten:
workspace vinner, sedan hanterade/lokala, därefter bundlade.

## Plugins + skills

Plugins kan leverera egna skills genom att lista `skills`-kataloger i
`openclaw.plugin.json` (sökvägar relativa till plugin-roten). Plugin-skills laddas
när pluginet är aktiverat och deltar i de normala prioriteringsreglerna för skills.
Du kan spärra dem via `metadata.openclaw.requires.config` i pluginets konfigpost.
Se [Plugins](/tools/plugin) för discovery/konfiguration och [Tools](/tools) för den
verktygsyta som dessa skills lär ut.

## ClawHub (installera + synka)

ClawHub är det publika skills-registret för OpenClaw. Bläddra på
[https://clawhub.com](https://clawhub.com). Använd det för att upptäcka, installera, uppdatera och säkerhetskopiera skills.
Fullständig guide: [ClawHub](/tools/clawhub).

Vanliga flöden:

- Installera en skill i din workspace:
  - `clawhub install <skill-slug>`
- Uppdatera alla installerade skills:
  - `clawhub update --all`
- Synka (skanna + publicera uppdateringar):
  - `clawhub sync --all`

Som standard installerar `clawhub` i `./skills` under din aktuella
arbetskatalog (eller faller tillbaka till den konfigurerade OpenClaw-workspace).
OpenClaw plockar upp detta som `<workspace>/skills` vid nästa session.

## Säkerhetsnoteringar

- Behandla tredjeparts-skills som **icke betrodd kod**. Läs dem innan aktivering.
- Föredra sandboxade körningar för obetrodda indata och riskfyllda verktyg. Se [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` och `skills.entries.*.apiKey` injicerar hemligheter i **värdprocessen**
  för den agentvändan (inte i sandboxen). Håll hemligheter borta från promptar och loggar.
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
  - `user-invocable` — `true|false` (standard: `true`). När `true` exponeras skillen som ett användar-snedstreckskommando.
  - `disable-model-invocation` — `true|false` (standard: `false`). När `true` exkluderas skillen från modellprompten (fortfarande tillgänglig via användarinvokering).
  - `command-dispatch` — `tool` (valfritt). När satt till `tool` kringgår snedstreckskommandot modellen och skickas direkt till ett verktyg.
  - `command-tool` — verktygsnamn att anropa när `command-dispatch: tool` är satt.
  - `command-arg-mode` — `raw` (standard). För verktygsdispatch vidarebefordras den råa args-strängen till verktyget (ingen kärnparsning).

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
- `os` — valfri lista med plattformar (`darwin`, `linux`, `win32`). Om satt är skillen endast giltig på dessa OS.
- `requires.bins` — lista; var och en måste finnas på `PATH`.
- `requires.anyBins` — lista; minst en måste finnas på `PATH`.
- `requires.env` — lista; env-var måste finnas **eller** tillhandahållas i konfig.
- `requires.config` — lista med `openclaw.json`-sökvägar som måste vara truthy.
- `primaryEnv` — env-varnamn associerat med `skills.entries.<name>.apiKey`.
- `install` — valfri array av installerarspecifikationer som används av macOS Skills-UI:t (brew/node/go/uv/download).

Not om sandboxing:

- `requires.bins` kontrolleras på **värden** vid skill-laddning.
- Om en agent är sandboxad måste binären även finnas **inne i containern**.
  Installera den via `agents.defaults.sandbox.docker.setupCommand` (eller en anpassad image).
  `setupCommand` körs en gång efter att containern skapats.
  Paketinstallationer kräver också nätverksutgående trafik, skrivbart root-FS och root-användare i sandboxen.
  Exempel: `summarize`-skillen (`skills/summarize/SKILL.md`) behöver `summarize` CLI
  i sandbox-containern för att köras där.

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
- Node-installationer följer `skills.install.nodeManager` i `openclaw.json` (standard: npm; alternativ: npm/pnpm/yarn/bun).
  Detta påverkar endast **skill-installationer**; Gateway-körtiden ska fortfarande vara Node
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

Konfig-nycklar matchar **skill-namnet** som standard. Om en skill definierar
`metadata.openclaw.skillKey`, använd den nyckeln under `skills.entries`.

Regler:

- `enabled: false` inaktiverar skillen även om den är bundlad/installerad.
- `env`: injiceras **endast om** variabeln inte redan är satt i processen.
- `apiKey`: bekvämlighet för skills som deklarerar `metadata.openclaw.primaryEnv`.
- `config`: valfri påse för anpassade per-skill-fält; anpassade nycklar måste ligga här.
- `allowBundled`: valfri tillåtelselista endast för **bundlade** skills. Om satt är endast
  bundlade skills i listan giltiga (hanterade/workspace-skills påverkas inte).

## Miljöinjektion (per agentkörning)

När en agentkörning startar gör OpenClaw:

1. Läser skill-metadata.
2. Tillämpar eventuella `skills.entries.<key>.env` eller `skills.entries.<key>.apiKey` på
   `process.env`.
3. Bygger systemprompten med **giltiga** skills.
4. Återställer den ursprungliga miljön efter att körningen avslutats.

Detta är **avgränsat till agentkörningen**, inte en global skalmiljö.

## Sessionssnapshot (prestanda)

OpenClaw tar en snapshot av de giltiga skills **när en session startar** och återanvänder den listan för efterföljande vändor i samma session. Ändringar i skills eller konfig träder i kraft vid nästa nya session.

Skills kan också uppdateras mitt i sessionen när skills-watchern är aktiverad eller när en ny giltig fjärrnod dyker upp (se nedan). Se detta som en **hot reload**: den uppdaterade listan används vid nästa agentvända.

## Fjärr-macOS-noder (Linux-gateway)

Om Gateway körs på Linux men en **macOS-nod** är ansluten **med `system.run` tillåtet** (Exec approvals-säkerhet inte satt till `deny`), kan OpenClaw behandla macOS-specifika skills som giltiga när nödvändiga binärer finns på den noden. Agenten bör exekvera dessa skills via verktyget `nodes` (vanligen `nodes.run`).

Detta förlitar sig på att noden rapporterar sitt kommandostöd och på en bin-probe via `system.run`. Om macOS-noden senare går offline förblir skills synliga; anrop kan misslyckas tills noden återansluter.

## Skills watcher (automatisk uppdatering)

Som standard bevakar OpenClaw skill-mappar och uppdaterar skills-snapshoten när `SKILL.md`-filer ändras. Konfigurera detta under `skills.load`:

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

När skills är giltiga injicerar OpenClaw en kompakt XML-lista över tillgängliga skills i systemprompten (via `formatSkillsForPrompt` i `pi-coding-agent`). Kostnaden är deterministisk:

- **Basöverhead (endast när ≥1 skill):** 195 tecken.
- **Per skill:** 97 tecken + längden på de XML-escapade `<name>`, `<description>` och `<location>`-värdena.

Formel (tecken):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Noteringar:

- XML-escaping expanderar `& < > " '` till entiteter (`&amp;`, `&lt;`, etc.), vilket ökar längden.
- Tokental varierar per modelltokenizer. En grov OpenAI-liknande uppskattning är ~4 tecken/token, så **97 tecken ≈ 24 token** per skill plus dina faktiska fältlängder.

## Livscykel för hanterade skills

OpenClaw levererar en basuppsättning skills som **bundlade skills** som del av
installationen (npm-paket eller OpenClaw.app). `~/.openclaw/skills` finns för lokala
åsidosättningar (till exempel att låsa/patcha en skill utan att ändra den bundlade
kopian). Workspace-skills ägs av användaren och åsidosätter båda vid namnkonflikter.

## Konfigreferens

Se [Skills config](/tools/skills-config) för det fullständiga konfigurationsschemat.

## Letar du efter fler skills?

Bläddra på [https://clawhub.com](https://clawhub.com).

---
