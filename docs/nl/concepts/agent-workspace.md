---
summary: "Agent-werkruimte: locatie, indeling en back-upstrategie"
read_when:
  - Je moet de agent-werkruimte of de bestandsindeling uitleggen
  - Je wilt een agent-werkruimte back-uppen of migreren
title: "Agent-werkruimte"
---

# Agent-werkruimte

De werkruimte is het thuis van de agent. Het is de enige werkmap die wordt
gebruikt voor bestandstools en voor werkruimtecontext. Houd deze privé en
behandel haar als geheugen.

Dit staat los van `~/.openclaw/`, waarin config, referenties en sessies worden
opgeslagen.

**Belangrijk:** de werkruimte is de **standaard cwd**, geen harde sandbox. Tools
lossen relatieve paden op ten opzichte van de werkruimte, maar absolute paden
kunnen nog steeds elders op de host uitkomen, tenzij sandboxing is ingeschakeld. Als je isolatie nodig hebt, gebruik [`agents.defaults.sandbox`](/gateway/sandboxing)
(en/of per‑agent sandbox-config).
Wanneer sandboxing is ingeschakeld en
`workspaceAccess` niet `"rw"` is, werken tools binnen een sandbox-
werkruimte onder `~/.openclaw/sandboxes`, niet in je host-werkruimte.

## Standaardlocatie

- Standaard: `~/.openclaw/workspace`
- Als `OPENCLAW_PROFILE` is ingesteld en niet `"default"`, wordt de standaard
  `~/.openclaw/workspace-<profile>`.
- Overschrijven in `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` of `openclaw setup` maken de werkruimte aan en
zetten de bootstrapbestanden klaar als ze ontbreken.

Als je de werkruimtebestanden zelf al beheert, kun je het aanmaken van
bootstrapbestanden uitschakelen:

```json5
{ agent: { skipBootstrap: true } }
```

## Extra werkruimtemappen

Oudere installaties kunnen `~/openclaw` hebben aangemaakt. Het behouden van
meerdere werkruimtemappen kan verwarrende authenticatie of statusdrift
veroorzaken, omdat er steeds maar één werkruimte actief is.

**Aanbeveling:** houd één actieve werkruimte. Als je de extra mappen niet meer
gebruikt, archiveer ze of verplaats ze naar de prullenbak (bijvoorbeeld
`trash ~/openclaw`).
Als je bewust meerdere werkruimtes aanhoudt, zorg er dan voor
dat `agents.defaults.workspace` naar de actieve wijst.

`openclaw doctor` waarschuwt wanneer het extra werkruimtemappen detecteert.

## Werkruimte-bestandskaart (wat elk bestand betekent)

Dit zijn de standaardbestanden die OpenClaw in de werkruimte verwacht:

- `AGENTS.md`
  - Bedieningsinstructies voor de agent en hoe hij geheugen moet gebruiken.
  - Wordt geladen bij de start van elke sessie.
  - Goede plek voor regels, prioriteiten en details over “hoe je je gedraagt”.

- `SOUL.md`
  - Persona, toon en grenzen.
  - Wordt elke sessie geladen.

- `USER.md`
  - Wie de gebruiker is en hoe je hem/haar aanspreekt.
  - Wordt elke sessie geladen.

- `IDENTITY.md`
  - De naam, vibe en emoji van de agent.
  - Aangemaakt/bijgewerkt tijdens het bootstrapritueel.

- `TOOLS.md`
  - Notities over je lokale tools en conventies.
  - Stuurt de beschikbaarheid van tools niet aan; het is alleen richtlijn.

- `HEARTBEAT.md`
  - Optionele kleine checklist voor heartbeat-runs.
  - Houd het kort om te voorkomen dat het token brandt.

- `BOOT.md`
  - Optionele opstartchecklist die wordt uitgevoerd bij een Gateway-herstart
    wanneer interne hooks zijn ingeschakeld.
  - Houd het kort; gebruik de message tool voor uitgaande berichten.

- `BOOTSTRAP.md`
  - Eenmalig first-run-ritueel.
  - Wordt alleen aangemaakt voor een gloednieuwe werkruimte.
  - Verwijder het nadat het ritueel is voltooid.

- `memory/YYYY-MM-DD.md`
  - Dagelijks geheugenlogboek (één bestand per dag).
  - Aanbevolen om vandaag + gisteren te lezen bij sessiestart.

- `MEMORY.md` (optioneel)
  - Gecureerd langetermijngeheugen.
  - Alleen laden in de hoofd-, privé­sessie (niet in gedeelde/groepscontexten).

Zie [Memory](/concepts/memory) voor de workflow en automatische geheugenflush.

- `skills/` (optioneel)
  - Werkruimtespecifieke Skills.
  - Overschrijft beheerde/gebundelde Skills wanneer namen botsen.

- `canvas/` (optioneel)
  - Canvas-UI-bestanden voor node-weergaven (bijvoorbeeld `canvas/index.html`).

Als een bootstrapbestand ontbreekt, injecteert OpenClaw een markering “missing
file” in de sessie en gaat verder. Grote bootstrapbestanden worden afgekapt bij
injectie; pas de limiet aan met `agents.defaults.bootstrapMaxChars` (standaard: 20000).
`openclaw setup` kan ontbrekende standaardwaarden opnieuw aanmaken zonder
bestaande bestanden te overschrijven.

## Wat NIET in de werkruimte staat

Deze bevinden zich onder `~/.openclaw/` en mogen NIET worden gecommit naar de
werkruimte-repo:

- `~/.openclaw/openclaw.json` (config)
- `~/.openclaw/credentials/` (OAuth-tokens, API-sleutels)
- `~/.openclaw/agents/<agentId>/sessions/` (sessietranscripten + metadata)
- `~/.openclaw/skills/` (beheerde Skills)

Als je sessies of config moet migreren, kopieer ze dan afzonderlijk en houd ze
buiten versiebeheer.

## Git-back-up (aanbevolen, privé)

Behandel de werkruimte als privégeheugen. Plaats deze in een **privé**
git-repository zodat ze is geback-upt en herstelbaar.

Voer deze stappen uit op de machine waar de Gateway draait (daar bevindt zich de
werkruimte).

### 1. Initialiseer de repo

Als git is geïnstalleerd, worden gloednieuwe werkruimtes automatisch
geïnitialiseerd. Als deze werkruimte nog geen repo is, voer dan uit:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. Voeg een privé remote toe (beginnersvriendelijke opties)

Optie A: GitHub web-UI

1. Maak een nieuwe **privé** repository aan op GitHub.
2. Initialiseer niet met een README (voorkomt mergeconflicten).
3. Kopieer de HTTPS-remote-URL.
4. Voeg de remote toe en push:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Optie B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Optie C: GitLab web-UI

1. Maak een nieuwe **privé** repository aan op GitLab.
2. Initialiseer niet met een README (voorkomt mergeconflicten).
3. Kopieer de HTTPS-remote-URL.
4. Voeg de remote toe en push:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. Doorlopende updates

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Commit geen geheimen

Vermijd, zelfs in een privérepo, het opslaan van geheimen in de werkruimte:

- API-sleutels, OAuth-tokens, wachtwoorden of privéreferenties.
- Alles onder `~/.openclaw/`.
- Ruwe dumps van chats of gevoelige bijlagen.

Als je gevoelige verwijzingen moet opslaan, gebruik dan placeholders en bewaar
het echte geheim elders (wachtwoordmanager, omgevingsvariabelen of
`~/.openclaw/`).

Voorgestelde `.gitignore`-starter:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## De werkruimte verplaatsen naar een nieuwe machine

1. Clone de repo naar het gewenste pad (standaard `~/.openclaw/workspace`).
2. Stel `agents.defaults.workspace` in op dat pad in `~/.openclaw/openclaw.json`.
3. Voer `openclaw setup --workspace <path>` uit om ontbrekende bestanden aan te maken.
4. Als je sessies nodig hebt, kopieer `~/.openclaw/agents/<agentId>/sessions/` afzonderlijk van de oude
   machine.

## Geavanceerde notities

- Multi-agent-routering kan verschillende werkruimtes per agent gebruiken. Zie
  [Channel routing](/channels/channel-routing) voor routeringsconfiguratie.
- Als `agents.defaults.sandbox` is ingeschakeld, kunnen niet-hoofdsessies per-sessie
  sandbox-werkruimtes gebruiken onder `agents.defaults.sandbox.workspaceRoot`.
