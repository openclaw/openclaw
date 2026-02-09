---
summary: "Gabay sa ClawHub: pampublikong registry ng skills + mga workflow ng CLI"
read_when:
  - Pagpapakilala ng ClawHub sa mga bagong user
  - Pag-install, paghahanap, o pag-publish ng skills
  - Pagpapaliwanag ng mga flag ng ClawHub CLI at behavior ng sync
title: "ClawHub"
---

# ClawHub

30. Ang ClawHub ay ang **pampublikong skill registry para sa OpenClaw**. Ito ay isang libreng serbisyo: lahat ng skill ay pampubliko, bukas, at nakikita ng lahat para sa pagbabahagi at muling paggamit. A skill is just a folder with a `SKILL.md` file (plus supporting text files). Maaari kang mag-browse ng mga skill sa web app o gamitin ang CLI upang maghanap, mag-install, mag-update, at mag-publish ng mga skill.

Site: [clawhub.ai](https://clawhub.ai)

## Ano ang ClawHub

- Isang pampublikong registry para sa OpenClaw skills.
- Isang versioned na imbakan ng mga skill bundle at metadata.
- Isang discovery surface para sa search, tags, at mga usage signal.

## Paano ito gumagana

1. Nagpa-publish ang isang user ng skill bundle (mga file + metadata).
2. Iniimbak ng ClawHub ang bundle, pini-parse ang metadata, at nagtatalaga ng version.
3. Ini-index ng registry ang skill para sa search at discovery.
4. Nagba-browse, nagda-download, at nag-i-install ang mga user ng skills sa OpenClaw.

## Ano ang maaari mong gawin

- Mag-publish ng mga bagong skills at bagong version ng mga umiiral na skills.
- Tumuklas ng skills ayon sa pangalan, tags, o search.
- Mag-download ng mga skill bundle at suriin ang kanilang mga file.
- Mag-report ng mga skill na abusado o hindi ligtas.
- Kung ikaw ay moderator, mag-hide, mag-unhide, mag-delete, o mag-ban.

## Para kanino ito (beginner-friendly)

Kung nais mong magdagdag ng mga bagong kakayahan sa iyong OpenClaw agent, ang ClawHub ang pinakamadaling paraan upang makahanap at mag-install ng mga skill. Hindi mo kailangang malaman kung paano gumagana ang backend. 32. Maaari kang:

- Maghanap ng skills gamit ang plain language.
- Mag-install ng skill sa iyong workspace.
- Mag-update ng skills sa susunod gamit ang isang command.
- Mag-back up ng sarili mong skills sa pamamagitan ng pag-publish ng mga ito.

## Mabilis na pagsisimula (non-technical)

1. I-install ang CLI (tingnan ang susunod na seksyon).
2. Maghanap ng kailangan mo:
   - `clawhub search "calendar"`
3. Mag-install ng skill:
   - `clawhub install <skill-slug>`
4. Magsimula ng bagong OpenClaw session para ma-pick up nito ang bagong skill.

## I-install ang CLI

Pumili ng isa:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## Paano ito umaangkop sa OpenClaw

Bilang default, ini-install ng CLI ang mga skill sa `./skills` sa ilalim ng iyong kasalukuyang working directory. 33. Kung may naka-configure na OpenClaw workspace, babalik ang `clawhub` sa workspace na iyon maliban kung i-override mo ang `--workdir` (o `CLAWHUB_WORKDIR`). Ilo-load ng OpenClaw ang mga workspace skill mula sa `<workspace>/skills` at kukunin ang mga ito sa **susunod** na session. 34. Kung gumagamit ka na ng `~/.openclaw/skills` o mga bundled skill, mas may prioridad ang mga skill sa workspace.

Para sa mas detalyadong paliwanag kung paano nilo-load, sini-share, at ginagate ang skills, tingnan ang
[Skills](/tools/skills).

## Pangkalahatang-ideya ng skill system

35. Ang isang skill ay isang versioned na bundle ng mga file na nagtuturo sa OpenClaw kung paano magsagawa ng isang
    partikular na gawain. Bawat publish ay lumilikha ng bagong bersyon, at pinapanatili ng registry ang isang
    kasaysayan ng mga bersyon upang ma-audit ng mga user ang mga pagbabago.

Karaniwang kasama sa isang skill ang:

- Isang `SKILL.md` file na may pangunahing paglalarawan at paggamit.
- Opsyonal na mga config, script, o suportang file na ginagamit ng skill.
- Metadata tulad ng tags, buod, at mga kinakailangan sa pag-install.

Gumagamit ang ClawHub ng metadata upang paganahin ang discovery at ligtas na ilantad ang mga kakayahan ng skill.
Sinusubaybayan din ng registry ang mga usage signal (tulad ng mga star at download) upang mapabuti ang
ranking at visibility.

## Ano ang ibinibigay ng serbisyo (mga tampok)

- **Pampublikong pag-browse** ng skills at ng kanilang `SKILL.md` na content.
- **Search** na pinapagana ng embeddings (vector search), hindi lang keywords.
- **Versioning** gamit ang semver, mga changelog, at tags (kasama ang `latest`).
- **Mga download** bilang zip kada version.
- **Stars at comments** para sa feedback ng komunidad.
- **Moderation** hooks para sa approvals at audits.
- **CLI-friendly API** para sa automation at scripting.

## Seguridad at moderation

Bukas ang ClawHub bilang default. Maaaring mag-upload ng mga skill ang sinuman, ngunit ang isang GitHub account ay dapat
hindi bababa sa isang linggong gulang upang makapag-publish. Nakakatulong ito na pabagalin ang pang-aabuso nang hindi hinaharangan ang
mga lehitimong contributor.

Pag-report at moderation:

- Kahit sinong naka-sign in na user ay maaaring mag-report ng skill.
- Kinakailangan at nire-record ang mga dahilan ng report.
- Bawat user ay maaaring magkaroon ng hanggang 20 aktibong report sa isang pagkakataon.
- Ang mga skill na may higit sa 3 natatanging report ay awtomatikong hina-hide bilang default.
- Maaaring tingnan ng mga moderator ang mga naka-hide na skill, i-unhide ang mga ito, i-delete, o mag-ban ng mga user.
- Ang pag-abuso sa report feature ay maaaring magresulta sa pag-ban ng account.

Interested in becoming a moderator? Ask in the OpenClaw Discord and contact a
moderator or maintainer.

## Mga command at parameter ng CLI

Mga global option (naaangkop sa lahat ng command):

- `--workdir <dir>`: Working directory (default: kasalukuyang dir; bumabalik sa OpenClaw workspace).
- `--dir <dir>`: Skills directory, relative sa workdir (default: `skills`).
- `--site <url>`: Base URL ng site (browser login).
- `--registry <url>`: Base URL ng registry API.
- `--no-input`: I-disable ang prompts (non-interactive).
- `-V, --cli-version`: I-print ang bersyon ng CLI.

Auth:

- `clawhub login` (browser flow) o `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

Options:

- `--token <token>`: I-paste ang API token.
- `--label <label>`: Label na ini-store para sa browser login tokens (default: `CLI token`).
- `--no-browser`: Huwag magbukas ng browser (nangangailangan ng `--token`).

Search:

- `clawhub search "query"`
- `--limit <n>`: Max na resulta.

Install:

- `clawhub install <slug>`
- `--version <version>`: Mag-install ng isang partikular na version.
- `--force`: I-overwrite kung umiiral na ang folder.

Update:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: Mag-update sa isang partikular na version (isang slug lang).
- `--force`: I-overwrite kapag ang mga lokal na file ay hindi tumutugma sa alinmang published version.

List:

- `clawhub list` (binabasa ang `.clawhub/lock.json`)

Publish:

- `clawhub publish <path>`
- `--slug <slug>`: Skill slug.
- `--name <name>`: Display name.
- `--version <version>`: Semver version.
- `--changelog <text>`: Teksto ng changelog (maaaring walang laman).
- `--tags <tags>`: Comma-separated na tags (default: `latest`).

Delete/undelete (owner/admin lamang):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

Sync (i-scan ang lokal na skills + i-publish ang bago/na-update):

- `clawhub sync`
- `--root <dir...>`: Mga dagdag na scan root.
- `--all`: I-upload ang lahat nang walang prompts.
- `--dry-run`: Ipakita kung ano ang ia-upload.
- `--bump <type>`: `patch|minor|major` para sa mga update (default: `patch`).
- `--changelog <text>`: Changelog para sa non-interactive na mga update.
- `--tags <tags>`: Comma-separated na tags (default: `latest`).
- `--concurrency <n>`: Mga registry check (default: 4).

## Mga karaniwang workflow para sa agents

### Maghanap ng skills

```bash
clawhub search "postgres backups"
```

### Mag-download ng mga bagong skills

```bash
clawhub install my-skill-pack
```

### Mag-update ng mga naka-install na skills

```bash
clawhub update --all
```

### Mag-back up ng iyong skills (publish o sync)

Para sa iisang skill folder:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

Para mag-scan at mag-back up ng maraming skills nang sabay-sabay:

```bash
clawhub sync --all
```

## Mga advanced na detalye (teknikal)

### Versioning at tags

- Bawat publish ay lumilikha ng bagong **semver** `SkillVersion`.
- Ang mga tag (tulad ng `latest`) ay tumuturo sa isang version; ang paglipat ng mga tag ay nagbibigay-daan para mag-roll back.
- Ang mga changelog ay naka-attach kada version at maaaring walang laman kapag nag-sync o nagpa-publish ng mga update.

### Mga lokal na pagbabago vs mga version sa registry

Updates compare the local skill contents to registry versions using a content hash. If local files do not match any published version, the CLI asks before overwriting (or requires `--force` in non-interactive runs).

### Pag-scan ng sync at mga fallback root

`clawhub sync` scans your current workdir first. If no skills are found, it falls back to known legacy locations (for example `~/openclaw/skills` and `~/.openclaw/skills`). 36. Dinisenyo ito upang mahanap ang mas matatandang skill install nang walang karagdagang flag.

### Storage at lockfile

- Ang mga naka-install na skill ay nire-record sa `.clawhub/lock.json` sa ilalim ng iyong workdir.
- Ang mga auth token ay ini-store sa ClawHub CLI config file (maaaring i-override sa pamamagitan ng `CLAWHUB_CONFIG_PATH`).

### Telemetry (bilang ng install)

When you run `clawhub sync` while logged in, the CLI sends a minimal snapshot to compute install counts. 37. Maaari mo itong ganap na i-disable:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Mga environment variable

- `CLAWHUB_SITE`: I-override ang site URL.
- `CLAWHUB_REGISTRY`: I-override ang registry API URL.
- `CLAWHUB_CONFIG_PATH`: I-override kung saan ini-store ng CLI ang token/config.
- `CLAWHUB_WORKDIR`: I-override ang default na workdir.
- `CLAWHUB_DISABLE_TELEMETRY=1`: I-disable ang telemetry sa `sync`.
