---
summary: "ClawHub-guide: offentlig Skills-register + CLI-arbetsflöden"
read_when:
  - Introducera ClawHub för nya användare
  - Installera, söka efter eller publicera skills
  - Förklara ClawHub CLI-flaggor och synkroniseringsbeteende
title: "ClawHub"
---

# ClawHub

ClawHub är **det offentliga kunskapsregistret för OpenClaw**. Det är en gratis tjänst: alla färdigheter är offentliga, öppna och synliga för alla för att dela och återanvända. En färdighet är bara en mapp med en 'SKILL.md' fil (plus stöd för textfiler). Du kan bläddra bland färdigheter i webbappen eller använda CLI för att söka, installera, uppdatera och publicera färdigheter.

Webbplats: [clawhub.ai](https://clawhub.ai)

## Vad ClawHub är

- Ett offentligt register för OpenClaw Skills.
- Ett versionshanterat lager av skill-paket och metadata.
- En upptäcktsyta för sökning, taggar och användningssignaler.

## Hur det fungerar

1. En användare publicerar ett skill-paket (filer + metadata).
2. ClawHub lagrar paketet, tolkar metadata och tilldelar en version.
3. Registret indexerar skillen för sökning och discovery.
4. Användare bläddrar, laddar ner och installerar skills i OpenClaw.

## Vad du kan göra

- Publicera nya skills och nya versioner av befintliga skills.
- Upptäcka skills via namn, taggar eller sökning.
- Ladda ner skill-paket och inspektera deras filer.
- Rapportera skills som är kränkande eller osäkra.
- Om du är moderator: dölja, visa, ta bort eller banna.

## Vem detta är för (nybörjarvänligt)

Om du vill lägga till nya funktioner till din OpenClaw agent, är ClawHub det enklaste sättet att hitta och installera färdigheter. Du behöver inte veta hur backend fungerar. Du kan:

- Söka efter skills med vanligt språk.
- Installera en skill i din arbetsyta.
- Uppdatera skills senare med ett enda kommando.
- Säkerhetskopiera dina egna skills genom att publicera dem.

## Snabbstart (icke-teknisk)

1. Installera CLI:t (se nästa avsnitt).
2. Sök efter något du behöver:
   - `clawhub search "calendar"`
3. Installera en skill:
   - `clawhub install <skill-slug>`
4. Starta en ny OpenClaw-session så att den plockar upp den nya skillen.

## Installera CLI

Välj ett alternativ:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## Hur det passar in i OpenClaw

Som standard installerar CLI färdigheterna i `./skills` under din nuvarande arbetskatalog. Om en OpenClaw arbetsyta är konfigurerad, faller `clawhub` tillbaka till den arbetsytan om du inte åsidosätter `--workdir` (eller `CLAWHUB_WORKDIR`). OpenClaw laddar arbetsytans färdigheter från `<workspace>/skills` och kommer att plocka upp dem i **nästa** sessionen. Om du redan använder `~/.openclaw/skills` eller buntade färdigheter, har arbetsytans färdigheter företräde.

För mer detaljer om hur skills laddas, delas och begränsas, se
[Skills](/tools/skills).

## Översikt över skills-systemet

En färdighet är ett versionspaket av filer som lär OpenClaw hur man utför en
specifik uppgift. Varje publicering skapar en ny version, och registret har en
versionshistorik så att användarna kan granska förändringar.

En typisk skill innehåller:

- En `SKILL.md`-fil med den primära beskrivningen och användningen.
- Valfria konfigar, script eller stödjande filer som används av skillen.
- Metadata som taggar, sammanfattning och installationskrav.

ClawHub använder metadata för att driva upptäckt och på ett säkert sätt avslöja färdighetsegenskaper.
Registret spårar också användarsignaler (såsom stjärnor och nedladdningar) för att förbättra
ranking och synlighet.

## Vad tjänsten tillhandahåller (funktioner)

- **Offentlig bläddring** av skills och deras `SKILL.md`-innehåll.
- **Sökning** driven av embeddings (vektorsökning), inte bara nyckelord.
- **Versionshantering** med semver, ändringsloggar och taggar (inklusive `latest`).
- **Nedladdningar** som zip per version.
- **Stjärnor och kommentarer** för community-feedback.
- **Moderering** med stöd för godkännanden och granskningar.
- **CLI-vänligt API** för automatisering och scripting.

## Säkerhet och moderering

ClawHub är öppen som standard. Vem som helst kan ladda upp färdigheter, men ett GitHub-konto måste
vara minst en vecka gammalt för att publicera. Detta bidrar till att sakta ner missbruk utan att blockera
legitima bidragsgivare.

Rapportering och moderering:

- Alla inloggade användare kan rapportera en skill.
- Rapporteringsorsaker krävs och registreras.
- Varje användare kan ha upp till 20 aktiva rapporter samtidigt.
- Skills med mer än 3 unika rapporter döljs automatiskt som standard.
- Moderatorer kan se dolda skills, visa dem igen, ta bort dem eller banna användare.
- Missbruk av rapportfunktionen kan leda till kontobannlysning.

Är du intresserad av att bli moderator? Fråga i OpenClaw Discord och kontakta en
moderator eller ansvarig.

## CLI-kommandon och parametrar

Globala alternativ (gäller alla kommandon):

- `--workdir <dir>`: Arbetskatalog (standard: aktuell katalog; faller tillbaka till OpenClaw-arbetsyta).
- `--dir <dir>`: Skills-katalog, relativt arbetskatalogen (standard: `skills`).
- `--site <url>`: Bas-URL för webbplatsen (inloggning i webbläsare).
- `--registry <url>`: Bas-URL för register-API:t.
- `--no-input`: Inaktivera prompts (icke-interaktivt).
- `-V, --cli-version`: Skriv ut CLI-version.

Autentisering:

- `clawhub login` (webbläsarflöde) eller `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

Alternativ:

- `--token <token>`: Klistra in en API-token.
- `--label <label>`: Etikett som lagras för webbläsarinloggningstokens (standard: `CLI token`).
- `--no-browser`: Öppna inte en webbläsare (kräver `--token`).

Sök:

- `clawhub search "query"`
- `--limit <n>`: Max antal resultat.

Installera:

- `clawhub install <slug>`
- `--version <version>`: Installera en specifik version.
- `--force`: Skriv över om mappen redan finns.

Uppdatera:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: Uppdatera till en specifik version (endast en slug).
- `--force`: Skriv över när lokala filer inte matchar någon publicerad version.

Lista:

- `clawhub list` (läser `.clawhub/lock.json`)

Publicera:

- `clawhub publish <path>`
- `--slug <slug>`: Skill-slug.
- `--name <name>`: Visningsnamn.
- `--version <version>`: Semver-version.
- `--changelog <text>`: Ändringsloggtext (kan vara tom).
- `--tags <tags>`: Kommaseparerade taggar (standard: `latest`).

Ta bort/återställ (endast ägare/admin):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

Synk (skanna lokala skills + publicera nya/uppdaterade):

- `clawhub sync`
- `--root <dir...>`: Extra skanningsrötter.
- `--all`: Ladda upp allt utan prompts.
- `--dry-run`: Visa vad som skulle laddas upp.
- `--bump <type>`: `patch|minor|major` för uppdateringar (standard: `patch`).
- `--changelog <text>`: Ändringslogg för icke-interaktiva uppdateringar.
- `--tags <tags>`: Kommaseparerade taggar (standard: `latest`).
- `--concurrency <n>`: Registerkontroller (standard: 4).

## Vanliga arbetsflöden för agenter

### Söka efter skills

```bash
clawhub search "postgres backups"
```

### Ladda ner nya skills

```bash
clawhub install my-skill-pack
```

### Uppdatera installerade skills

```bash
clawhub update --all
```

### Säkerhetskopiera dina skills (publicera eller synka)

För en enskild skill-mapp:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

För att skanna och säkerhetskopiera många skills på en gång:

```bash
clawhub sync --all
```

## Avancerade detaljer (tekniskt)

### Versionshantering och taggar

- Varje publicering skapar en ny **semver** `SkillVersion`.
- Taggar (som `latest`) pekar på en version; genom att flytta taggar kan du rulla tillbaka.
- Ändringsloggar är kopplade per version och kan vara tomma vid synk eller publicering av uppdateringar.

### Lokala ändringar vs registerversioner

Uppdateringar jämför det lokala kunskapsinnehållet med registerversioner med hjälp av en innehållshash. Om lokala filer inte matchar någon publicerad version, frågar CLI innan överskrivning (eller kräver `--force` i icke-interaktiva körningar).

### Synk-skanning och fallback-rötter

`clawhub sync` skannar din nuvarande workdir först. Om inga färdigheter hittas, faller det tillbaka till kända äldre platser (till exempel `~/openclaw/skills` och `~/.openclaw/skills`). Detta är utformat för att hitta äldre färdighetsinstallationer utan extra flaggor.

### Lagring och låsfil

- Installerade skills registreras i `.clawhub/lock.json` under din arbetskatalog.
- Autentiseringstokens lagras i ClawHub CLI-konfigfilen (åsidosätt via `CLAWHUB_CONFIG_PATH`).

### Telemetri (installationsräkningar)

När du kör `clawhub sync` när du är inloggad skickar CLI en minimal ögonblicksbild för att beräkna installationsräkningar. Du kan inaktivera detta helt:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Miljövariabler

- `CLAWHUB_SITE`: Åsidosätt webbplatsens URL.
- `CLAWHUB_REGISTRY`: Åsidosätt register-API:ts URL.
- `CLAWHUB_CONFIG_PATH`: Åsidosätt var CLI:t lagrar token/konfig.
- `CLAWHUB_WORKDIR`: Åsidosätt standard-arbetskatalogen.
- `CLAWHUB_DISABLE_TELEMETRY=1`: Inaktivera telemetri för `sync`.
