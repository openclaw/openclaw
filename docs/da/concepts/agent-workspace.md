---
summary: "Agent-workspace: placering, layout og backupstrategi"
read_when:
  - Du skal forklare agent-workspacet eller dets fillayout
  - Du vil sikkerhedskopiere eller migrere et agent-workspace
title: "Agent Workspace"
---

# Agent-workspace

Arbejdsrummet er agentens hjem. Det er den eneste arbejdsmappe, der bruges til
-filværktøjer og til arbejdsrumssammenhæng. Hold den privat og behandl den som hukommelse.

Dette er adskilt fra `~/.openclaw/`, som gemmer konfiguration, legitimationsoplysninger og
sessioner.

**Vigtigt:** arbejdsområdet er **standard cwd**, ikke en hård sandkasse. Værktøjer
løser relative stier mod arbejdsområdet, men absolutte stier kan stadig nå
andre steder på værten, medmindre sandboxing er aktiveret. Hvis du har brug for isolation, brug
[`agents.defaults.sandbox`](/gateway/sandboxing) (og/eller per-agent sandbox config).
Når sandboxing er aktiveret og `workspaceAccess` er ikke `"rw"`, værktøjer operere
inde i en sandkasse arbejdsområde under `~/.openclaw/sandboxes`, ikke dit værts arbejdsområde.

## Standardplacering

- Standard: `~/.openclaw/workspace`
- Hvis `OPENCLAW_PROFILE` er sat og ikke er `"default"`, bliver standarden
  `~/.openclaw/workspace-<profile>`.
- Tilsidesæt i `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` eller `openclaw setup` opretter workspacet og
initialiserer bootstrap-filerne, hvis de mangler.

Hvis du allerede selv administrerer workspace-filerne, kan du deaktivere
oprettelse af bootstrap-filer:

```json5
{ agent: { skipBootstrap: true } }
```

## Ekstra workspace-mapper

Ældre installationer kan have oprettet `~/openclaw`. Holde flere arbejdsområde
mapper omkring kan forårsage forvirrende auth eller state drift, fordi kun et
arbejdsområde er aktivt ad gangen.

**Anbefaling:** behold et enkelt aktivt arbejdsområde. Hvis du ikke længere bruger
ekstra mapper, skal du arkivere dem eller flytte dem til papirkurven (for eksempel `trash ~/openclaw`).
Hvis du forsætligt beholder flere arbejdsområder, sørg for
`agents.defaults.workspace` peger på den aktive.

`openclaw doctor` advarer, når den registrerer ekstra workspace-mapper.

## Workspace-filoversigt (hvad hver fil betyder)

Dette er de standardfiler, OpenClaw forventer inde i workspacet:

- `AGENTS.md`
  - Driftsinstruktioner for agenten og hvordan den skal bruge hukommelse.
  - Indlæses ved starten af hver session.
  - Et godt sted til regler, prioriteter og detaljer om “hvordan man opfører sig”.

- `SOUL.md`
  - Persona, tone og grænser.
  - Indlæses i hver session.

- `USER.md`
  - Hvem brugeren er, og hvordan de skal tiltales.
  - Indlæses i hver session.

- `IDENTITY.md`
  - Agentens navn, vibe og emoji.
  - Oprettes/opdateres under bootstrap-ritualet.

- `TOOLS.md`
  - Noter om dine lokale værktøjer og konventioner.
  - Styrer ikke værktøjstilgængelighed; det er kun vejledning.

- `HEARTBEAT.md`
  - Valgfri lille tjekliste til heartbeat-kørsler.
  - Hold den kort for at undgå token-forbrug.

- `BOOT.md`
  - Valgfri opstartstjekliste, der udføres ved gateway-genstart, når interne hooks er aktiveret.
  - Hold den kort; brug message-værktøjet til udgående beskeder.

- `BOOTSTRAP.md`
  - Engangs-ritual ved første kørsel.
  - Oprettes kun for et helt nyt workspace.
  - Slet den, efter ritualet er fuldført.

- `memory/YYYY-MM-DD.md`
  - Daglig hukommelseslog (én fil pr. dag).
  - Anbefalet at læse i dag + i går ved sessionsstart.

- `MEMORY.md` (valgfri)
  - Kurateret langsigtet hukommelse.
  - Indlæs kun i den primære, private session (ikke i delte-/gruppekontekster).

Se [Memory](/concepts/memory) for workflowet og automatisk hukommelses-flush.

- `skills/` (valgfri)
  - Workspace-specifikke Skills.
  - Tilsidesætter administrerede/bundtede Skills, når navne kolliderer.

- `canvas/` (valgfri)
  - Canvas-UI-filer til node-visninger (for eksempel `canvas/index.html`).

Hvis nogen bootstrap fil mangler, tilfører OpenClaw en "manglende fil" markør i
sessionen og fortsætter. Store bootstrap filer afkortet når du injiceres;
justere grænsen med `agents.defaults.bootstrapMaxChars` (standard: 20000).
`openclaw setup` kan genskabe manglende standarder uden at overskrive eksisterende
filer.

## Hvad er IKKE i workspacet

Disse ligger under `~/.openclaw/` og bør IKKE commits til workspace-repoet:

- `~/.openclaw/openclaw.json` (konfiguration)
- `~/.openclaw/credentials/` (OAuth-tokens, API-nøgler)
- `~/.openclaw/agents/<agentId>/sessions/` (sessionstransskriptioner + metadata)
- `~/.openclaw/skills/` (administrerede Skills)

Hvis du skal migrere sessioner eller konfiguration, så kopiér dem separat og
hold dem ude af versionskontrol.

## Git-backup (anbefalet, privat)

Behandl arbejdsområdet som privat hukommelse. Placer det i en **private** git repo så det er
sikkerhedskopieret og inddrivelig.

Kør disse trin på den maskine, hvor Gateway kører (det er der, workspacet ligger).

### 1. Initialisér repoet

Hvis git er installeret, initialiseres helt nye arbejdsområder automatisk. Hvis dette
arbejdsområde ikke allerede er et repo, køre:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. Tilføj en privat remote (begyndervenlige muligheder)

Mulighed A: GitHub web-UI

1. Opret et nyt **privat** repository på GitHub.
2. Initialisér ikke med en README (undgår merge-konflikter).
3. Kopiér HTTPS remote-URL’en.
4. Tilføj remote og push:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Mulighed B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Mulighed C: GitLab web-UI

1. Opret et nyt **privat** repository på GitLab.
2. Initialisér ikke med en README (undgår merge-konflikter).
3. Kopiér HTTPS remote-URL’en.
4. Tilføj remote og push:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. Løbende opdateringer

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Commit ikke hemmeligheder

Selv i et privat repo bør du undgå at gemme hemmeligheder i workspacet:

- API-nøgler, OAuth-tokens, adgangskoder eller private legitimationsoplysninger.
- Alt under `~/.openclaw/`.
- Rå dumps af chats eller følsomme vedhæftninger.

Hvis du er nødt til at gemme følsomme referencer, så brug pladsholdere og opbevar
den rigtige hemmelighed et andet sted (password manager, miljøvariabler eller
`~/.openclaw/`).

Foreslået `.gitignore`-starter:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Flytning af workspacet til en ny maskine

1. Klon repoet til den ønskede sti (standard `~/.openclaw/workspace`).
2. Sæt `agents.defaults.workspace` til den sti i `~/.openclaw/openclaw.json`.
3. Kør `openclaw setup --workspace <path>` for at initialisere eventuelle manglende filer.
4. Hvis du har brug for sessioner, så kopiér `~/.openclaw/agents/<agentId>/sessions/` fra den
   gamle maskine separat.

## Avancerede noter

- Multi-agent routing kan bruge forskellige arbejdsområder pr. agent. Se
  [Kanal routing](/channels/channel-routing) for routing konfiguration.
- Hvis `agents.defaults.sandbox` er aktiveret, kan ikke-hovedsessioner bruge
  sandbox-workspaces pr. session under `agents.defaults.sandbox.workspaceRoot`.
