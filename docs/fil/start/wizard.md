---
summary: "CLI onboarding wizard: ginabayang setup para sa gateway, workspace, mga channel, at skills"
read_when:
  - Kapag pinapatakbo o kino-configure ang onboarding wizard
  - Kapag nagse-setup ng bagong makina
title: "Onboarding Wizard (CLI)"
sidebarTitle: "Onboarding: CLI"
x-i18n:
  source_path: start/wizard.md
  source_hash: 5495d951a2d78ffb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:01Z
---

# Onboarding Wizard (CLI)

Ang onboarding wizard ang **inirerekomendang** paraan para i-set up ang OpenClaw sa macOS,
Linux, o Windows (via WSL2; lubos na inirerekomenda).
Kino-configure nito ang lokal na Gateway o isang remote Gateway connection, pati ang mga channel, skills,
at mga default ng workspace sa isang ginabayang daloy.

```bash
openclaw onboard
```

<Info>
Pinakamabilis na unang chat: buksan ang Control UI (hindi kailangan ng channel setup). Patakbuhin ang
`openclaw dashboard` at makipag-chat sa browser. Docs: [Dashboard](/web/dashboard).
</Info>

Para mag-reconfigure sa ibang pagkakataon:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
Hindi ibig sabihin ng `--json` ay non-interactive mode. Para sa mga script, gamitin ang `--non-interactive`.
</Note>

<Tip>
Inirerekomenda: mag-set up ng Brave Search API key para magamit ng agent ang `web_search`
(`web_fetch` ay gumagana kahit walang key). Pinakamadaling paraan: `openclaw configure --section web`
na nag-i-store ng `tools.web.search.apiKey`. Docs: [Web tools](/tools/web).
</Tip>

## QuickStart vs Advanced

Nagsisimula ang wizard sa **QuickStart** (mga default) kumpara sa **Advanced** (buong kontrol).

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Lokal na gateway (loopback)
    - Default na workspace (o umiiral na workspace)
    - Gateway port **18789**
    - Gateway auth **Token** (auto‑generated, kahit sa loopback)
    - Tailscale exposure **Off**
    - Ang Telegram + WhatsApp DMs ay naka-default sa **allowlist** (hihingan ka ng iyong phone number)
  </Tab>
  <Tab title="Advanced (full control)">
    - Inilalantad ang bawat hakbang (mode, workspace, gateway, channels, daemon, skills).
  </Tab>
</Tabs>

## Ano ang kino-configure ng wizard

**Local mode (default)** ay ginagabayan ka sa mga hakbang na ito:

1. **Model/Auth** — Anthropic API key (inirerekomenda), OAuth, OpenAI, o iba pang provider. Pumili ng default na model.
2. **Workspace** — Lokasyon para sa mga agent file (default `~/.openclaw/workspace`). Nagse-seed ng mga bootstrap file.
3. **Gateway** — Port, bind address, auth mode, Tailscale exposure.
4. **Channels** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles, o iMessage.
5. **Daemon** — Nag-i-install ng LaunchAgent (macOS) o systemd user unit (Linux/WSL2).
6. **Health check** — Sinisimulan ang Gateway at tine-verify na ito ay tumatakbo.
7. **Skills** — Nag-i-install ng mga inirerekomendang skills at mga opsyonal na dependency.

<Note>
Ang muling pagpapatakbo ng wizard ay **hindi** nagbubura ng anuman maliban kung tahasan mong piliin ang **Reset** (o ipasa ang `--reset`).
Kung invalid ang config o may mga legacy key, hihilingin ng wizard na patakbuhin mo muna ang `openclaw doctor`.
</Note>

Ang **Remote mode** ay kino-configure lamang ang lokal na client para kumonekta sa isang Gateway sa ibang lugar.
**Hindi** ito nag-i-install o nagbabago ng anuman sa remote host.

## Magdagdag ng isa pang agent

Gamitin ang `openclaw agents add <name>` para lumikha ng hiwalay na agent na may sarili nitong workspace,
mga session, at auth profile. Ang pagpapatakbo nang walang `--workspace` ay maglulunsad ng wizard.

Ano ang itinatakda nito:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Mga tala:

- Ang mga default na workspace ay sumusunod sa `~/.openclaw/workspace-<agentId>`.
- Idagdag ang `bindings` para i-route ang mga papasok na mensahe (magagawa ito ng wizard).
- Mga non-interactive flag: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Buong reference

Para sa detalyadong step-by-step na breakdown, non-interactive scripting, Signal setup,
RPC API, at kumpletong listahan ng mga field ng config na isinusulat ng wizard, tingnan ang
[Wizard Reference](/reference/wizard).

## Kaugnay na docs

- CLI command reference: [`openclaw onboard`](/cli/onboard)
- macOS app onboarding: [Onboarding](/start/onboarding)
- Agent first-run ritual: [Agent Bootstrapping](/start/bootstrapping)
