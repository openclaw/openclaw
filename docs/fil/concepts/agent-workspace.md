---
summary: "Workspace ng agent: lokasyon, layout, at estratehiya sa backup"
read_when:
  - Kailangan mong ipaliwanag ang agent workspace o ang layout ng mga file nito
  - Gusto mong mag-back up o mag-migrate ng agent workspace
title: "Agent Workspace"
---

# Agent workspace

Ang workspace ang tahanan ng agent. Ito ang nag-iisang working directory na ginagamit para sa
file tools at para sa workspace context. Panatilihin itong pribado at ituring ito bilang memorya.

Hiwalay ito sa `~/.openclaw/`, na naglalaman ng config, mga credential, at mga session.

**Mahalaga:** ang workspace ang **default cwd**, hindi isang mahigpit na sandbox. Nire-resolve ng mga tool
ang mga relative path laban sa workspace, ngunit ang mga absolute path ay maaari pa ring umabot
sa ibang bahagi ng host maliban kung naka-enable ang sandboxing. Kung kailangan mo ng isolation, gamitin ang
[`agents.defaults.sandbox`](/gateway/sandboxing) (at/o per‑agent sandbox config).
Kapag naka-enable ang sandboxing at ang `workspaceAccess` ay hindi \`

## Default na lokasyon

- Default: `~/.openclaw/workspace`
- Kung naka-set ang `OPENCLAW_PROFILE` at hindi `"default"`, nagiging default ang
  `~/.openclaw/workspace-<profile>`.
- I-override sa `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Ang `openclaw onboard`, `openclaw configure`, o `openclaw setup` ay lilikha ng
workspace at magse-seed ng mga bootstrap file kung wala ang mga ito.

Kung ikaw na mismo ang namamahala sa mga file ng workspace, maaari mong i-disable ang paglikha ng mga bootstrap file:

```json5
{ agent: { skipBootstrap: true } }
```

## Mga dagdag na folder ng workspace

rw", ang mga tool ay gumagana
sa loob ng isang sandbox workspace sa ilalim ng `~/.openclaw/sandboxes`, hindi sa iyong host workspace. Maaaring nakalikha ang mga mas lumang install ng `~/openclaw`.

Ang pagpapanatili ng maraming workspace
directory ay maaaring magdulot ng nakalilitong auth o state drift, dahil iisa lamang
ang aktibong workspace sa isang pagkakataon. **Rekomendasyon:** panatilihin ang iisang aktibong workspace.
Kung hindi mo na ginagamit ang
mga dagdag na folder, i-archive o ilipat ang mga ito sa Trash (halimbawa `trash ~/openclaw`).

Nagbibigay ng babala ang `openclaw doctor` kapag may nadetektang dagdag na mga workspace directory.

## Mapa ng mga file sa workspace (ano ang ibig sabihin ng bawat file)

Ito ang mga standard na file na inaasahan ng OpenClaw sa loob ng workspace:

- `AGENTS.md`
  - Mga operating instruction para sa agent at kung paano nito gagamitin ang memorya.
  - Niloload sa simula ng bawat session.
  - Mainam na lugar para sa mga patakaran, prayoridad, at mga detalye ng “kung paano umasta”.

- `SOUL.md`
  - Persona, tono, at mga hangganan.
  - Niloload sa bawat session.

- `USER.md`
  - Kung sino ang user at kung paano sila tatawagin.
  - Niloload sa bawat session.

- `IDENTITY.md`
  - Pangalan ng agent, vibe, at emoji.
  - Ginagawa/ina-update sa panahon ng bootstrap ritual.

- `TOOLS.md`
  - Mga tala tungkol sa iyong lokal na mga tool at convention.
  - Hindi nito kinokontrol ang availability ng tool; gabay lamang ito.

- `HEARTBEAT.md`
  - Opsyonal na munting checklist para sa heartbeat runs.
  - Panatilihing maikli para maiwasan ang token burn.

- `BOOT.md`
  - Opsyonal na startup checklist na ine-execute sa gateway restart kapag naka-enable ang internal hooks.
  - Panatilihing maikli; gamitin ang message tool para sa outbound sends.

- `BOOTSTRAP.md`
  - One-time na first-run ritual.
  - Ginagawa lamang para sa isang brand-new na workspace.
  - Burahin ito pagkatapos makumpleto ang ritual.

- `memory/YYYY-MM-DD.md`
  - Araw-araw na memory log (isang file bawat araw).
  - Inirerekomendang basahin ang ngayon + kahapon sa simula ng session.

- `MEMORY.md` (opsyonal)
  - Curated na pangmatagalang memorya.
  - I-load lamang sa main, pribadong session (hindi sa shared/group contexts).

Tingnan ang [Memory](/concepts/memory) para sa workflow at awtomatikong memory flush.

- `skills/` (opsyonal)
  - Workspace-specific na Skills.
  - Ina-override ang managed/bundled skills kapag nagbanggaan ang mga pangalan.

- `canvas/` (opsyonal)
  - Mga Canvas UI file para sa mga node display (halimbawa `canvas/index.html`).

Kung sinasadya mong panatilihin ang maraming workspace, tiyaking
ang `agents.defaults.workspace` ay tumuturo sa aktibo. Kung may nawawalang anumang bootstrap file, nag-iinject ang OpenClaw ng isang marker na "missing file" sa
session at nagpapatuloy.
Ang malalaking bootstrap file ay pinuputol kapag ini-inject;
i-adjust ang limitasyon gamit ang `agents.defaults.bootstrapMaxChars` (default: 20000).

## Ano ang HINDI kasama sa workspace

Ang mga ito ay nasa ilalim ng `~/.openclaw/` at HINDI dapat i-commit sa workspace repo:

- `~/.openclaw/openclaw.json` (config)
- `~/.openclaw/credentials/` (OAuth tokens, API keys)
- `~/.openclaw/agents/<agentId>/sessions/` (mga transcript ng session + metadata)
- `~/.openclaw/skills/` (managed skills)

Kung kailangan mong i-migrate ang mga session o config, kopyahin ang mga ito nang hiwalay at
panatilihing wala sa version control.

## Git backup (inirerekomenda, pribado)

Maaaring muling likhain ng `openclaw setup` ang mga nawawalang default nang hindi pinapatungan ang mga umiiral na
file. Ituring ang workspace bilang pribadong memorya.

Patakbuhin ang mga hakbang na ito sa machine kung saan tumatakbo ang Gateway (doon nakatira ang
workspace).

### 1. I-initialize ang repo

Ilagay ito sa isang **pribadong** git repo upang ito ay
ma-back up at marekober. Kung naka-install ang git, ang mga bagong-bagong workspace ay awtomatikong ini-initialize.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. Magdagdag ng pribadong remote (beginner-friendly na mga opsyon)

Opsyon A: GitHub web UI

1. Gumawa ng bagong **pribadong** repository sa GitHub.
2. Huwag i-initialize gamit ang README (umiwas sa merge conflicts).
3. Kopyahin ang HTTPS remote URL.
4. Idagdag ang remote at mag-push:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Opsyon B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Opsyon C: GitLab web UI

1. Gumawa ng bagong **pribadong** repository sa GitLab.
2. Huwag i-initialize gamit ang README (umiwas sa merge conflicts).
3. Kopyahin ang HTTPS remote URL.
4. Idagdag ang remote at mag-push:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. Mga tuloy-tuloy na update

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Huwag mag-commit ng mga lihim

Kahit sa pribadong repo, iwasang mag-imbak ng mga lihim sa workspace:

- Mga API key, OAuth token, password, o pribadong credential.
- Anumang nasa ilalim ng `~/.openclaw/`.
- Mga raw dump ng chat o sensitibong attachment.

Kung kailangan talagang mag-imbak ng sensitibong reference, gumamit ng mga placeholder at
panatilihin ang totoong lihim sa ibang lugar (password manager, mga environment variable, o
`~/.openclaw/`).

Iminungkahing `.gitignore` starter:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Paglipat ng workspace sa bagong machine

1. I-clone ang repo sa nais na path (default `~/.openclaw/workspace`).
2. Itakda ang `agents.defaults.workspace` sa path na iyon sa `~/.openclaw/openclaw.json`.
3. Patakbuhin ang `openclaw setup --workspace <path>` para mag-seed ng anumang nawawalang file.
4. Kung kailangan mo ng mga session, kopyahin ang `~/.openclaw/agents/<agentId>/sessions/` mula sa
   lumang machine nang hiwalay.

## Mga advanced na tala

- Kung ang
  workspace na ito ay hindi pa isang repo, patakbuhin: Maaaring gumamit ang multi-agent routing ng magkakaibang workspace kada agent.
- Kung naka-enable ang `agents.defaults.sandbox`, ang mga non-main na session ay maaaring gumamit ng per-session sandbox
  workspace sa ilalim ng `agents.defaults.sandbox.workspaceRoot`.
