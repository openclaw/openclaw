---
summary: "Agent-workspace: placering, layout og backupstrategi"
read_when:
  - Du skal forklare agent-workspacet eller dets fillayout
  - Du vil sikkerhedskopiere eller migrere et agent-workspace
title: "Agent Workspace"
x-i18n:
  source_path: concepts/agent-workspace.md
  source_hash: d3cc655c58f00965
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:18Z
---

# Agent-workspace

Workspacet er agentens hjem. Det er den eneste arbejdsmappe, der bruges til
filværktøjer og til workspace-kontekst. Hold det privat, og behandl det som hukommelse.

Dette er adskilt fra `~/.openclaw/`, som gemmer konfiguration, legitimationsoplysninger og
sessioner.

**Vigtigt:** workspacet er **standard cwd**, ikke en hård sandbox. Værktøjer
opløser relative stier i forhold til workspacet, men absolutte stier kan stadig
nå andre steder på værten, medmindre sandboxing er aktiveret. Hvis du har brug
for isolation, så brug [`agents.defaults.sandbox`](/gateway/sandboxing) (og/eller
sandbox-konfiguration pr. agent). Når sandboxing er aktiveret, og `workspaceAccess`
ikke er `"rw"`, arbejder værktøjer inde i et sandbox-workspace under
`~/.openclaw/sandboxes`, ikke dit værts-workspace.

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

Ældre installationer kan have oprettet `~/openclaw`. At have flere
workspace-mapper liggende kan give forvirrende auth- eller tilstandsdrift, fordi
kun ét workspace er aktivt ad gangen.

**Anbefaling:** behold ét enkelt aktivt workspace. Hvis du ikke længere bruger
de ekstra mapper, så arkivér dem eller flyt dem til Papirkurven (for eksempel
`trash ~/openclaw`). Hvis du bevidst beholder flere workspaces, skal du sikre, at
`agents.defaults.workspace` peger på det aktive.

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

Hvis en bootstrap-fil mangler, indsætter OpenClaw en “missing file”-markør i
sessionen og fortsætter. Store bootstrap-filer afkortes, når de indsættes;
justér grænsen med `agents.defaults.bootstrapMaxChars` (standard: 20000).
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

Behandl workspacet som privat hukommelse. Læg det i et **privat** git-repo, så
det er sikkerhedskopieret og kan gendannes.

Kør disse trin på den maskine, hvor Gateway kører (det er der, workspacet ligger).

### 1) Initialisér repoet

Hvis git er installeret, initialiseres helt nye workspaces automatisk. Hvis dette
workspace ikke allerede er et repo, så kør:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) Tilføj en privat remote (begyndervenlige muligheder)

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

### 3) Løbende opdateringer

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

- Multi-agent-routing kan bruge forskellige workspaces pr. agent. Se
  [Channel routing](/channels/channel-routing) for routing-konfiguration.
- Hvis `agents.defaults.sandbox` er aktiveret, kan ikke-hovedsessioner bruge
  sandbox-workspaces pr. session under `agents.defaults.sandbox.workspaceRoot`.
