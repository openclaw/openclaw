---
summary: "ClawHub-handleiding: openbare skills-registratie + CLI-workflows"
read_when:
  - ClawHub introduceren aan nieuwe gebruikers
  - Skills installeren, zoeken of publiceren
  - CLI-vlaggen en sync-gedrag van ClawHub uitleggen
title: "ClawHub"
---

# ClawHub

ClawHub is het **openbare skills-register voor OpenClaw**. Het is een gratis dienst: alle skills zijn openbaar, open en voor iedereen zichtbaar om te delen en opnieuw te gebruiken. Een skill is simpelweg een map met een `SKILL.md`-bestand (plus ondersteunende tekstbestanden). Je kunt skills bekijken in de webapp of de CLI gebruiken om skills te zoeken, installeren, bijwerken en publiceren.

Site: [clawhub.ai](https://clawhub.ai)

## Wat ClawHub is

- Een openbaar register voor OpenClaw Skills.
- Een geversioneerde opslag van skill-bundels en metadata.
- Een discovery-oppervlak voor zoeken, tags en gebruikssignalen.

## Hoe het werkt

1. Een gebruiker publiceert een skill-bundel (bestanden + metadata).
2. ClawHub slaat de bundel op, parseert metadata en kent een versie toe.
3. Het register indexeert de skill voor zoeken en discovery.
4. Gebruikers bekijken, downloaden en installeren skills in OpenClaw.

## Wat je kunt doen

- Nieuwe skills en nieuwe versies van bestaande skills publiceren.
- Skills ontdekken op naam, tags of via zoeken.
- Skill-bundels downloaden en hun bestanden inspecteren.
- Skills rapporteren die misbruikmakend of onveilig zijn.
- Als je moderator bent: verbergen, zichtbaar maken, verwijderen of verbannen.

## Voor wie dit is (beginnersvriendelijk)

Als je nieuwe mogelijkheden wilt toevoegen aan je OpenClaw-agent, is ClawHub de eenvoudigste manier om skills te vinden en te installeren. Je hoeft niet te weten hoe de backend werkt. Je kunt:

- Skills zoeken met gewone taal.
- Een skill in je werkruimte installeren.
- Skills later met één opdracht bijwerken.
- Je eigen skills back-uppen door ze te publiceren.

## Snelle start (niet-technisch)

1. Installeer de CLI (zie volgende sectie).
2. Zoek naar wat je nodig hebt:
   - `clawhub search "calendar"`
3. Installeer een skill:
   - `clawhub install <skill-slug>`
4. Start een nieuwe OpenClaw-sessie zodat de nieuwe skill wordt opgepikt.

## De CLI installeren

Kies er één:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## Hoe het in OpenClaw past

Standaard installeert de CLI skills in `./skills` onder je huidige werkmap. Als een OpenClaw-werkruimte is geconfigureerd, valt `clawhub` terug op die werkruimte, tenzij je `--workdir` (of `CLAWHUB_WORKDIR`) overschrijft. OpenClaw laadt werkruimte-skills uit `<workspace>/skills` en pikt ze op in de **volgende** sessie. Als je al `~/.openclaw/skills` of gebundelde skills gebruikt, krijgen werkruimte-skills voorrang.

Voor meer details over hoe skills worden geladen, gedeeld en afgeschermd, zie
[Skills](/tools/skills).

## Overzicht van het skill-systeem

Een skill is een geversioneerde bundel van bestanden die OpenClaw leert hoe een
specifieke taak uit te voeren. Elke publicatie maakt een nieuwe versie aan, en het register bewaart een
geschiedenis van versies zodat gebruikers wijzigingen kunnen auditen.

Een typische skill bevat:

- Een `SKILL.md`-bestand met de primaire beschrijving en het gebruik.
- Optionele configs, scripts of ondersteunende bestanden die door de skill worden gebruikt.
- Metadata zoals tags, samenvatting en installatievereisten.

ClawHub gebruikt metadata om discovery mogelijk te maken en skill-capaciteiten veilig bloot te leggen.
Het register houdt ook gebruikssignalen bij (zoals sterren en downloads) om
ranking en zichtbaarheid te verbeteren.

## Wat de dienst biedt (features)

- **Openbaar browsen** van skills en hun `SKILL.md`-inhoud.
- **Zoeken** aangedreven door embeddings (vector search), niet alleen trefwoorden.
- **Versionering** met semver, changelogs en tags (inclusief `latest`).
- **Downloads** als een zip per versie.
- **Sterren en reacties** voor communityfeedback.
- **Moderatie**-hooks voor goedkeuringen en audits.
- **CLI-vriendelijke API** voor automatisering en scripting.

## Beveiliging en moderatie

ClawHub is standaard open. Iedereen kan skills uploaden, maar een GitHub-account moet
minstens één week oud zijn om te kunnen publiceren. Dit helpt misbruik te vertragen zonder
legitieme bijdragers te blokkeren.

Rapportage en moderatie:

- Elke ingelogde gebruiker kan een skill rapporteren.
- Rapportredenen zijn verplicht en worden vastgelegd.
- Elke gebruiker kan maximaal 20 actieve rapporten tegelijk hebben.
- Skills met meer dan 3 unieke rapporten worden standaard automatisch verborgen.
- Moderators kunnen verborgen skills bekijken, zichtbaar maken, verwijderen of gebruikers verbannen.
- Misbruik van de rapportagefunctie kan leiden tot accountverbanning.

Geïnteresseerd om moderator te worden? Vraag het in de OpenClaw Discord en neem contact op met een
moderator of maintainer.

## CLI-opdrachten en parameters

Globale opties (van toepassing op alle opdrachten):

- `--workdir <dir>`: Werkmap (standaard: huidige map; valt terug op OpenClaw-werkruimte).
- `--dir <dir>`: Skills-map, relatief aan werkmap (standaard: `skills`).
- `--site <url>`: Basis-URL van de site (browser-login).
- `--registry <url>`: Basis-URL van de registry-API.
- `--no-input`: Prompts uitschakelen (niet-interactief).
- `-V, --cli-version`: CLI-versie afdrukken.

Auth:

- `clawhub login` (browser-flow) of `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

Opties:

- `--token <token>`: Plak een API-token.
- `--label <label>`: Label dat wordt opgeslagen voor browser-login-tokens (standaard: `CLI token`).
- `--no-browser`: Geen browser openen (vereist `--token`).

Zoeken:

- `clawhub search "query"`
- `--limit <n>`: Maximaal aantal resultaten.

Installeren:

- `clawhub install <slug>`
- `--version <version>`: Installeer een specifieke versie.
- `--force`: Overschrijf als de map al bestaat.

Bijwerken:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: Bijwerken naar een specifieke versie (slechts één slug).
- `--force`: Overschrijven wanneer lokale bestanden niet overeenkomen met een gepubliceerde versie.

Lijst:

- `clawhub list` (leest `.clawhub/lock.json`)

Publiceren:

- `clawhub publish <path>`
- `--slug <slug>`: Skill-slug.
- `--name <name>`: Weergavenaam.
- `--version <version>`: Semver-versie.
- `--changelog <text>`: Changelog-tekst (kan leeg zijn).
- `--tags <tags>`: Door komma’s gescheiden tags (standaard: `latest`).

Verwijderen/ongedaan maken (alleen eigenaar/admin):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

Sync (lokale skills scannen + nieuwe/bijgewerkte publiceren):

- `clawhub sync`
- `--root <dir...>`: Extra scan-roots.
- `--all`: Alles uploaden zonder prompts.
- `--dry-run`: Tonen wat er zou worden geüpload.
- `--bump <type>`: `patch|minor|major` voor updates (standaard: `patch`).
- `--changelog <text>`: Changelog voor niet-interactieve updates.
- `--tags <tags>`: Door komma’s gescheiden tags (standaard: `latest`).
- `--concurrency <n>`: Registry-checks (standaard: 4).

## Veelvoorkomende workflows voor agents

### Zoeken naar skills

```bash
clawhub search "postgres backups"
```

### Nieuwe skills downloaden

```bash
clawhub install my-skill-pack
```

### Geïnstalleerde skills bijwerken

```bash
clawhub update --all
```

### Je skills back-uppen (publiceren of syncen)

Voor één skill-map:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

Om veel skills tegelijk te scannen en back-uppen:

```bash
clawhub sync --all
```

## Geavanceerde details (technisch)

### Versionering en tags

- Elke publicatie maakt een nieuwe **semver** `SkillVersion` aan.
- Tags (zoals `latest`) wijzen naar een versie; door tags te verplaatsen kun je terugrollen.
- Changelogs zijn per versie gekoppeld en kunnen leeg zijn bij syncen of publiceren van updates.

### Lokale wijzigingen vs. registry-versies

Updates vergelijken de lokale skill-inhoud met registry-versies met behulp van een content-hash. Als lokale bestanden niet overeenkomen met een gepubliceerde versie, vraagt de CLI om bevestiging voordat wordt overschreven (of vereist `--force` bij niet-interactieve runs).

### Sync-scanning en fallback-roots

`clawhub sync` scant eerst je huidige werkmap. Als er geen skills worden gevonden, valt het terug op bekende legacy-locaties (bijvoorbeeld `~/openclaw/skills` en `~/.openclaw/skills`). Dit is ontworpen om oudere skill-installaties te vinden zonder extra flags.

### Opslag en lockfile

- Geïnstalleerde skills worden vastgelegd in `.clawhub/lock.json` onder je werkmap.
- Auth-tokens worden opgeslagen in het ClawHub CLI-configbestand (overschrijven via `CLAWHUB_CONFIG_PATH`).

### Telemetrie (installatie-aantallen)

Wanneer je `clawhub sync` uitvoert terwijl je bent ingelogd, stuurt de CLI een minimale snapshot om installatie-aantallen te berekenen. Je kunt dit volledig uitschakelen:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Omgevingsvariabelen

- `CLAWHUB_SITE`: De site-URL overschrijven.
- `CLAWHUB_REGISTRY`: De registry-API-URL overschrijven.
- `CLAWHUB_CONFIG_PATH`: Overschrijven waar de CLI het token/config opslaat.
- `CLAWHUB_WORKDIR`: De standaard werkmap overschrijven.
- `CLAWHUB_DISABLE_TELEMETRY=1`: Telemetrie uitschakelen bij `sync`.
