---
summary: "Agentens arbetsyta: plats, layout och säkerhetskopieringsstrategi"
read_when:
  - Du behöver förklara agentens arbetsyta eller dess fillayout
  - Du vill säkerhetskopiera eller migrera en agents arbetsyta
title: "Agentens arbetsyta"
---

# Agentens arbetsyta

Arbetsytan är agentens hem. Det är den enda arbetskatalog som används för
filverktyg och för arbetsytan. Håll den privat och behandla den som minne.

Detta är separat från `~/.openclaw/`, som lagrar konfig, autentiseringsuppgifter och
sessioner.

**Viktigt:** arbetsytan är **standard cwd**, inte en hård sandlåda. Verktyg
löser relativa sökvägar mot arbetsytan, men absoluta sökvägar kan fortfarande nå
någon annanstans på värden såvida inte sandlådan är aktiverad. Om du behöver isolering, använd
[`agents.defaults.sandbox`](/gateway/sandboxing) (och/eller per-agent sandbox config).
När sandlådan är aktiverad och `workspaceAccess` är inte `"rw"`, använder verktyg
i en sandlåda arbetsyta under `~/.openclaw/sandlådor`, inte din värd arbetsyta.

## Standardplats

- Standard: `~/.openclaw/workspace`
- Om `OPENCLAW_PROFILE` är satt och inte är `"default"`, blir standard
  `~/.openclaw/workspace-<profile>`.
- Åsidosätt i `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` eller `openclaw setup` skapar
arbetsytan och lägger in bootstrap‑filerna om de saknas.

Om du redan hanterar arbetsytans filer själv kan du inaktivera skapandet av
bootstrap‑filer:

```json5
{ agent: { skipBootstrap: true } }
```

## Extra arbetsytemappar

Äldre installationer kan ha skapat `~/openclaw`. Att hålla flera arbetsytor
-kataloger runt kan orsaka förvirrande auth eller tillståndsavdrift, eftersom endast en
arbetsyta är aktiv åt gången.

**Rekommendation:** behålla en enda aktiv arbetsyta. Om du inte längre använder extramapparna
arkivera eller flytta dem till papperskorgen (till exempel `trash ~/openclaw`).
Om du avsiktligt behåller flera arbetsytor, se till att
`agents.defaults.workspace` pekar till den aktiva.

`openclaw doctor` varnar när den upptäcker extra arbetsytekataloger.

## Arbetsytans filkarta (vad varje fil betyder)

Detta är standardfilerna som OpenClaw förväntar sig i arbetsytan:

- `AGENTS.md`
  - Driftinstruktioner för agenten och hur den ska använda minne.
  - Lästs in i början av varje session.
  - En bra plats för regler, prioriteringar och detaljer om ”hur man ska bete sig”.

- `SOUL.md`
  - Persona, ton och gränser.
  - Lästs in varje session.

- `USER.md`
  - Vem användaren är och hur de ska tilltalas.
  - Lästs in varje session.

- `IDENTITY.md`
  - Agentens namn, vibe och emoji.
  - Skapas/uppdateras under bootstrap‑ritualen.

- `TOOLS.md`
  - Anteckningar om dina lokala verktyg och konventioner.
  - Styr inte verktygstillgänglighet; det är endast vägledning.

- `HEARTBEAT.md`
  - Valfri liten checklista för heartbeat‑körningar.
  - Håll den kort för att undvika tokenförbrukning.

- `BOOT.md`
  - Valfri startchecklista som körs vid gateway‑omstart när interna hooks är aktiverade.
  - Håll den kort; använd meddelandeverktyget för utgående skick.

- `BOOTSTRAP.md`
  - Engångsritual vid första körningen.
  - Skapas endast för en helt ny arbetsyta.
  - Ta bort den efter att ritualen är klar.

- `memory/YYYY-MM-DD.md`
  - Daglig minneslogg (en fil per dag).
  - Rekommenderas att läsa i dag + i går vid sessionsstart.

- `MEMORY.md` (valfri)
  - Kurerat långtidsminne.
  - Ladda endast i den huvudsakliga, privata sessionen (inte delade/gruppsammanhang).

Se [Memory](/concepts/memory) för arbetsflödet och automatisk minnesspolning.

- `skills/` (valfri)
  - Arbetsytsspecifika Skills.
  - Åsidosätter hanterade/buntade Skills när namn krockar.

- `canvas/` (valfri)
  - Canvas‑UI‑filer för nodvisningar (till exempel `canvas/index.html`).

Om någon bootstrap-fil saknas, injicerar OpenClaw en "saknad fil" markör i
sessionen och fortsätter. Stora bootstrap-filer trunkeras när de injiceras;
justera gränsen med `agents.defaults.bootstrapMaxChars` (standard: 20000).
`openclaw setup` kan återskapa saknade standardinställningar utan att skriva över befintliga
-filer.

## Vad som INTE finns i arbetsytan

Dessa finns under `~/.openclaw/` och ska INTE checkas in i arbetsyterepot:

- `~/.openclaw/openclaw.json` (konfig)
- `~/.openclaw/credentials/` (OAuth‑tokenar, API‑nycklar)
- `~/.openclaw/agents/<agentId>/sessions/` (sessionstranskript + metadata)
- `~/.openclaw/skills/` (hanterade Skills)

Om du behöver migrera sessioner eller konfig, kopiera dem separat och håll dem
utanför versionskontroll.

## Git‑backup (rekommenderad, privat)

Behandla arbetsytan som privat minne. Sätt den i en **privat** git repo så den är
säkerhetskopierad och återställbar.

Kör dessa steg på maskinen där Gateway körs (det är där arbetsytan finns).

### 1. Initiera repot

Om git är installerat initieras helt nya arbetsytor automatiskt. Om denna
arbetsyta inte redan är en repo, köra:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. Lägg till en privat fjärr (nybörjarvänliga alternativ)

Alternativ A: GitHub webb‑UI

1. Skapa ett nytt **privat** repo på GitHub.
2. Initiera inte med en README (undviker merge‑konflikter).
3. Kopiera HTTPS‑URL:en för fjärren.
4. Lägg till fjärren och pusha:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Alternativ B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Alternativ C: GitLab webb‑UI

1. Skapa ett nytt **privat** repo på GitLab.
2. Initiera inte med en README (undviker merge‑konflikter).
3. Kopiera HTTPS‑URL:en för fjärren.
4. Lägg till fjärren och pusha:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. Löpande uppdateringar

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Checka inte in hemligheter

Även i ett privat repo bör du undvika att lagra hemligheter i arbetsytan:

- API‑nycklar, OAuth‑tokenar, lösenord eller privata autentiseringsuppgifter.
- Allt under `~/.openclaw/`.
- Råa dumpningar av chattar eller känsliga bilagor.

Om du måste lagra känsliga referenser, använd platshållare och håll den riktiga
hemligheten någon annanstans (lösenordshanterare, miljövariabler eller
`~/.openclaw/`).

Föreslagen `.gitignore`‑start:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Flytta arbetsytan till en ny maskin

1. Klona repot till önskad sökväg (standard `~/.openclaw/workspace`).
2. Sätt `agents.defaults.workspace` till den sökvägen i `~/.openclaw/openclaw.json`.
3. Kör `openclaw setup --workspace <path>` för att lägga in eventuella saknade filer.
4. Om du behöver sessioner, kopiera `~/.openclaw/agents/<agentId>/sessions/` från den
   gamla maskinen separat.

## Avancerade noteringar

- Multi-agent routing kan använda olika arbetsytor per agent. Se
  [Kanalrouting](/channels/channel-routing) för routingkonfiguration.
- Om `agents.defaults.sandbox` är aktiverat kan icke‑huvudsessioner använda
  sandbox‑arbetsytor per session under `agents.defaults.sandbox.workspaceRoot`.
