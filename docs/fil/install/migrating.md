---
summary: "Ilipat (i-migrate) ang isang OpenClaw install mula sa isang makina patungo sa isa pa"
read_when:
  - Ililipat mo ang OpenClaw sa bagong laptop/server
  - Gusto mong mapanatili ang mga session, auth, at mga login ng channel (WhatsApp, atbp.)
title: "Gabay sa Migration"
---

# Pag-migrate ng OpenClaw sa bagong makina

Ang gabay na ito ay naglilipat ng isang OpenClaw Gateway mula sa isang makina patungo sa isa pa **nang hindi inuulit ang onboarding**.

Simple lang ang migration sa konsepto:

- Kopyahin ang **state directory** (`$OPENCLAW_STATE_DIR`, default: `~/.openclaw/`) — kasama rito ang config, auth, mga session, at estado ng channel.
- Kopyahin ang iyong **workspace** (`~/.openclaw/workspace/` bilang default) — kasama rito ang iyong mga agent file (memory, prompts, atbp.).

Ngunit may mga karaniwang footgun kaugnay ng **profiles**, **permissions**, at **partial copies**.

## Bago ka magsimula (kung ano ang imi-migrate mo)

### 1. Tukuyin ang iyong state directory

Karamihan ng install ay gumagamit ng default:

- **State dir:** `~/.openclaw/`

Ngunit maaaring iba ito kung gumagamit ka ng:

- `--profile <name>` (madalas nagiging `~/.openclaw-<profile>/`)
- `OPENCLAW_STATE_DIR=/some/path`

Kung hindi ka sigurado, patakbuhin sa **lumang** makina:

```bash
openclaw status
```

Maghanap ng mga banggit ng `OPENCLAW_STATE_DIR` / profile sa output. Kung nagpapatakbo ka ng maraming gateway, ulitin ito para sa bawat profile.

### 2. Tukuyin ang iyong workspace

Mga karaniwang default:

- `~/.openclaw/workspace/` (inirerekomendang workspace)
- isang custom na folder na ikaw ang gumawa

Ang iyong workspace ang kinalalagyan ng mga file tulad ng `MEMORY.md`, `USER.md`, at `memory/*.md`.

### 3. Unawain kung ano ang mapapanatili mo

Kung kokopyahin mo **pareho** ang state dir at workspace, mapapanatili mo ang:

- Konpigurasyon ng Gateway (`openclaw.json`)
- Mga auth profile / API key / OAuth token
- Kasaysayan ng session + estado ng agent
- Estado ng channel (hal. login/session ng WhatsApp)
- Iyong mga workspace file (memory, Skills notes, atbp.)

Kung kokopyahin mo **workspace lang** (hal., via Git), **hindi** mo mapapanatili ang:

- mga session
- mga kredensyal
- mga login ng channel

Ang mga iyon ay nasa ilalim ng `$OPENCLAW_STATE_DIR`.

## Mga hakbang sa migration (inirerekomenda)

### Hakbang 0 — Gumawa ng backup (lumang makina)

Sa **lumang** makina, ihinto muna ang gateway para hindi nagbabago ang mga file habang kinokopya:

```bash
openclaw gateway stop
```

(Opsyonal ngunit inirerekomenda) i-archive ang state dir at workspace:

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

Kung mayroon kang maraming profile/state dir (hal. `~/.openclaw-main`, `~/.openclaw-work`), i-archive ang bawat isa.

### Hakbang 1 — I-install ang OpenClaw sa bagong makina

Sa **bagong** makina, i-install ang CLI (at Node kung kinakailangan):

- Tingnan: [Install](/install)

Sa yugtong ito, OK lang kung lumikha ang onboarding ng bagong `~/.openclaw/` — papalitan mo ito sa susunod na hakbang.

### Hakbang 2 — Kopyahin ang state dir + workspace papunta sa bagong makina

Kopyahin **pareho**:

- `$OPENCLAW_STATE_DIR` (default `~/.openclaw/`)
- ang iyong workspace (default `~/.openclaw/workspace/`)

Mga karaniwang paraan:

- `scp` ang mga tarball at i-extract
- `rsync -a` sa pamamagitan ng SSH
- external drive

Pagkatapos makopya, tiyakin na:

- Kasama ang mga hidden directory (hal. `.openclaw/`)
- Tama ang file ownership para sa user na nagpapatakbo ng gateway

### Hakbang 3 — Patakbuhin ang Doctor (migrations + pag-ayos ng service)

Sa **bagong** makina:

```bash
openclaw doctor
```

Ang Doctor ang “ligtas at boring” na command. Inaayos nito ang mga serbisyo, ina-apply ang mga config migration, at nagbababala tungkol sa mga mismatch.

Pagkatapos:

```bash
openclaw gateway restart
openclaw status
```

## Mga karaniwang footgun (at paano iwasan)

### Footgun: hindi tugmang profile / state-dir

Kung pinatakbo mo ang lumang gateway gamit ang isang profile (o `OPENCLAW_STATE_DIR`), at ang bagong gateway ay gumagamit ng iba, makakakita ka ng mga sintomas tulad ng:

- hindi ume-effect ang mga pagbabago sa config
- nawawala / naka-logout ang mga channel
- walang laman ang kasaysayan ng session

Ayusin: patakbuhin ang gateway/service gamit ang **parehong** profile/state dir na in-migrate mo, pagkatapos ay patakbuhin muli:

```bash
openclaw doctor
```

### Footgun: pagkopya lang ng `openclaw.json`

Hindi sapat ang `openclaw.json`. Maraming provider ang nag-iimbak ng state sa ilalim ng:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

Palaging i-migrate ang buong folder na `$OPENCLAW_STATE_DIR`.

### Footgun: permissions / ownership

Kung kumopya ka bilang root o nagpalit ng user, maaaring mabigo ang gateway na basahin ang mga kredensyal/session.

Ayusin: tiyaking ang state dir + workspace ay pagmamay-ari ng user na nagpapatakbo ng gateway.

### Footgun: pag-migrate sa pagitan ng remote/local modes

- Kung ang iyong UI (WebUI/TUI) ay tumuturo sa isang **remote** na gateway, ang remote host ang may-ari ng session store + workspace.
- Ang pag-migrate ng iyong laptop ay hindi lilipat ng estado ng remote gateway.

Kung nasa remote mode ka, i-migrate ang **host ng Gateway**.

### Footgun: mga secret sa mga backup

Ang `$OPENCLAW_STATE_DIR` ay naglalaman ng mga lihim (API keys, OAuth tokens, WhatsApp creds). Tratuhin ang mga backup na parang production secrets:

- itago nang naka-encrypt
- iwasang ibahagi sa mga hindi secure na channel
- i-rotate ang mga key kung pinaghihinalaan mong na-expose

## Checklist sa beripikasyon

Sa bagong makina, tiyakin na:

- Ipinapakita ng `openclaw status` na tumatakbo ang gateway
- Nakakonekta pa rin ang iyong mga channel (hal. hindi na kailangang i-repair ang WhatsApp)
- Bumubukas ang dashboard at ipinapakita ang mga umiiral na session
- Naroon ang iyong mga workspace file (memory, mga config)

## Kaugnay

- [Doctor](/gateway/doctor)
- [Pag-troubleshoot ng Gateway](/gateway/troubleshooting)
- [Saan iniimbak ng OpenClaw ang data nito?](/help/faq#where-does-openclaw-store-its-data)
