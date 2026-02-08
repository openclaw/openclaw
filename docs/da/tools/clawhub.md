---
summary: "ClawHub-guide: offentlig Skills-registrering + CLI-arbejdsgange"
read_when:
  - Introduktion af ClawHub for nye brugere
  - Installation, søgning eller publicering af Skills
  - Forklaring af ClawHub CLI-flag og synkroniseringsadfærd
title: "ClawHub"
x-i18n:
  source_path: tools/clawhub.md
  source_hash: b572473a11246357
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:59Z
---

# ClawHub

ClawHub er **den offentlige Skills-registrering for OpenClaw**. Det er en gratis tjeneste: alle Skills er offentlige, åbne og synlige for alle til deling og genbrug. En Skill er blot en mappe med en `SKILL.md`-fil (plus understøttende tekstfiler). Du kan gennemse Skills i webappen eller bruge CLI’en til at søge, installere, opdatere og publicere Skills.

Site: [clawhub.ai](https://clawhub.ai)

## Hvad ClawHub er

- En offentlig registrering for OpenClaw Skills.
- Et versionsstyret lager af Skill-bundles og metadata.
- En Discovery-overflade til søgning, tags og brugssignaler.

## Sådan virker det

1. En bruger publicerer en Skill-bundle (filer + metadata).
2. ClawHub gemmer bundlen, parser metadata og tildeler en version.
3. Registreringen indekserer Skill’en til søgning og Discovery.
4. Brugere gennemser, downloader og installerer Skills i OpenClaw.

## Hvad du kan gøre

- Publicere nye Skills og nye versioner af eksisterende Skills.
- Opdage Skills efter navn, tags eller søgning.
- Downloade Skill-bundles og inspicere deres filer.
- Rapportere Skills, der er misbrugende eller usikre.
- Hvis du er moderator: skjule, vise igen, slette eller bandlyse.

## Hvem det er til (begyndervenligt)

Hvis du vil tilføje nye funktioner til din OpenClaw-agent, er ClawHub den nemmeste måde at finde og installere Skills på. Du behøver ikke at vide, hvordan backend’en fungerer. Du kan:

- Søge efter Skills med almindeligt sprog.
- Installere en Skill i dit workspace.
- Opdatere Skills senere med én kommando.
- Tage backup af dine egne Skills ved at publicere dem.

## Hurtig start (ikke-teknisk)

1. Installér CLI’en (se næste afsnit).
2. Søg efter det, du har brug for:
   - `clawhub search "calendar"`
3. Installér en Skill:
   - `clawhub install <skill-slug>`
4. Start en ny OpenClaw-session, så den samler den nye Skill op.

## Installér CLI’en

Vælg én:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## Sådan passer det ind i OpenClaw

Som standard installerer CLI’en Skills i `./skills` under din nuværende arbejdsmappe. Hvis et OpenClaw-workspace er konfigureret, falder `clawhub` tilbage til dette workspace, medmindre du tilsidesætter `--workdir` (eller `CLAWHUB_WORKDIR`). OpenClaw indlæser workspace-Skills fra `<workspace>/skills` og samler dem op i **næste** session. Hvis du allerede bruger `~/.openclaw/skills` eller bundtede Skills, har workspace-Skills forrang.

For flere detaljer om, hvordan Skills indlæses, deles og gates, se
[Skills](/tools/skills).

## Overblik over Skill-systemet

En Skill er en versionsstyret bundle af filer, der lærer OpenClaw at udføre en
specifik opgave. Hver publicering opretter en ny version, og registreringen
bevarer en historik over versioner, så brugere kan revidere ændringer.

En typisk Skill indeholder:

- En `SKILL.md`-fil med den primære beskrivelse og brug.
- Valgfrie konfigurationer, scripts eller understøttende filer, som Skill’en bruger.
- Metadata såsom tags, resumé og installationskrav.

ClawHub bruger metadata til at drive Discovery og sikkert eksponere Skill-funktioner.
Registreringen sporer også brugssignaler (såsom stjerner og downloads) for at forbedre
rangering og synlighed.

## Hvad tjenesten tilbyder (funktioner)

- **Offentlig gennemgang** af Skills og deres `SKILL.md`-indhold.
- **Søgning** drevet af embeddings (vektorsøgning), ikke kun nøgleord.
- **Versionsstyring** med semver, changelogs og tags (inklusive `latest`).
- **Downloads** som en zip pr. version.
- **Stjerner og kommentarer** til feedback fra fællesskabet.
- **Moderation**-hooks til godkendelser og audits.
- **CLI-venlig API** til automatisering og scripting.

## Sikkerhed og moderation

ClawHub er åbent som standard. Alle kan uploade Skills, men en GitHub-konto skal
være mindst én uge gammel for at kunne publicere. Det hjælper med at bremse misbrug
uden at blokere legitime bidragydere.

Rapportering og moderation:

- Enhver indlogget bruger kan rapportere en Skill.
- Rapportårsager er påkrævet og registreres.
- Hver bruger kan have op til 20 aktive rapporter ad gangen.
- Skills med mere end 3 unikke rapporter skjules automatisk som standard.
- Moderatorer kan se skjulte Skills, vise dem igen, slette dem eller bandlyse brugere.
- Misbrug af rapportfunktionen kan resultere i kontobandlysning.

Interesseret i at blive moderator? Spørg i OpenClaw Discord og kontakt en
moderator eller vedligeholder.

## CLI-kommandoer og parametre

Globale indstillinger (gælder for alle kommandoer):

- `--workdir <dir>`: Arbejdsmappe (standard: nuværende mappe; falder tilbage til OpenClaw-workspace).
- `--dir <dir>`: Skills-mappe, relativt til workdir (standard: `skills`).
- `--site <url>`: Site-base-URL (browser-login).
- `--registry <url>`: Registrerings-API base-URL.
- `--no-input`: Deaktivér prompts (ikke-interaktiv).
- `-V, --cli-version`: Udskriv CLI-version.

Auth:

- `clawhub login` (browser-flow) eller `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

Indstillinger:

- `--token <token>`: Indsæt et API-token.
- `--label <label>`: Etiket gemt for browser-login-tokens (standard: `CLI token`).
- `--no-browser`: Åbn ikke en browser (kræver `--token`).

Søgning:

- `clawhub search "query"`
- `--limit <n>`: Maks. resultater.

Installér:

- `clawhub install <slug>`
- `--version <version>`: Installér en specifik version.
- `--force`: Overskriv, hvis mappen allerede findes.

Opdater:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: Opdatér til en specifik version (kun enkelt slug).
- `--force`: Overskriv, når lokale filer ikke matcher nogen publiceret version.

Liste:

- `clawhub list` (læser `.clawhub/lock.json`)

Publicér:

- `clawhub publish <path>`
- `--slug <slug>`: Skill-slug.
- `--name <name>`: Vist navn.
- `--version <version>`: Semver-version.
- `--changelog <text>`: Changelog-tekst (kan være tom).
- `--tags <tags>`: Kommaseparerede tags (standard: `latest`).

Slet/gendan (kun ejer/admin):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

Sync (scan lokale Skills + publicér nye/opdaterede):

- `clawhub sync`
- `--root <dir...>`: Ekstra scan-roots.
- `--all`: Upload alt uden prompts.
- `--dry-run`: Vis, hvad der ville blive uploadet.
- `--bump <type>`: `patch|minor|major` for opdateringer (standard: `patch`).
- `--changelog <text>`: Changelog for ikke-interaktive opdateringer.
- `--tags <tags>`: Kommaseparerede tags (standard: `latest`).
- `--concurrency <n>`: Registreringskontroller (standard: 4).

## Almindelige arbejdsgange for agenter

### Søg efter Skills

```bash
clawhub search "postgres backups"
```

### Download nye Skills

```bash
clawhub install my-skill-pack
```

### Opdatér installerede Skills

```bash
clawhub update --all
```

### Tag backup af dine Skills (publicér eller sync)

For en enkelt Skill-mappe:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

For at scanne og tage backup af mange Skills på én gang:

```bash
clawhub sync --all
```

## Avancerede detaljer (teknisk)

### Versionsstyring og tags

- Hver publicering opretter en ny **semver** `SkillVersion`.
- Tags (som `latest`) peger på en version; flytning af tags lader dig rulle tilbage.
- Changelogs er knyttet pr. version og kan være tomme ved sync eller publicering af opdateringer.

### Lokale ændringer vs. registreringsversioner

Opdateringer sammenligner det lokale Skill-indhold med registreringsversioner ved hjælp af en indholdshash. Hvis lokale filer ikke matcher nogen publiceret version, spørger CLI’en før overskrivning (eller kræver `--force` i ikke-interaktive kørsler).

### Sync-scanning og fallback-roots

`clawhub sync` scanner først din nuværende workdir. Hvis der ikke findes nogen Skills, falder den tilbage til kendte legacy-placeringer (for eksempel `~/openclaw/skills` og `~/.openclaw/skills`). Dette er designet til at finde ældre Skill-installationer uden ekstra flags.

### Lagring og lockfile

- Installerede Skills registreres i `.clawhub/lock.json` under din workdir.
- Auth-tokens gemmes i ClawHub CLI-konfigurationsfilen (tilsidesæt via `CLAWHUB_CONFIG_PATH`).

### Telemetri (installationsantal)

Når du kører `clawhub sync` mens du er logget ind, sender CLI’en et minimalt snapshot for at beregne installationsantal. Du kan deaktivere dette helt:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Miljøvariabler

- `CLAWHUB_SITE`: Tilsidesæt site-URL’en.
- `CLAWHUB_REGISTRY`: Tilsidesæt registrerings-API-URL’en.
- `CLAWHUB_CONFIG_PATH`: Tilsidesæt hvor CLI’en gemmer token/konfiguration.
- `CLAWHUB_WORKDIR`: Tilsidesæt standard workdir.
- `CLAWHUB_DISABLE_TELEMETRY=1`: Deaktivér telemetri på `sync`.
