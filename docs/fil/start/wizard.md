---
summary: "CLI onboarding wizard: ginabayang setup para sa gateway, workspace, mga channel, at skills"
read_when:
  - Kapag pinapatakbo o kino-configure ang onboarding wizard
  - Kapag nagse-setup ng bagong makina
title: "Onboarding Wizard (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# Onboarding Wizard (CLI)

The onboarding wizard is the **recommended** way to set up OpenClaw on macOS,
Linux, or Windows (via WSL2; strongly recommended).
It configures a local Gateway or a remote Gateway connection, plus channels, skills,
and workspace defaults in one guided flow.

```bash
openclaw onboard
```

<Info>
Fastest first chat: open the Control UI (no channel setup needed). Run
`openclaw dashboard` and chat in the browser. Docs: [Dashboard](/web/dashboard).
</Info>

Para mag-reconfigure sa ibang pagkakataon:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` does not imply non-interactive mode. For scripts, use `--non-interactive`.
</Note>

<Tip>
Recommended: set up a Brave Search API key so the agent can use `web_search`
(`web_fetch` works without a key). 1. Pinakamadaling paraan: `openclaw configure --section web`
na nag-iimbak ng `tools.web.search.apiKey`. Docs: [Web tools](/tools/web).
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

1. 3. **Model/Auth** — Anthropic API key (inirerekomenda), OAuth, OpenAI, o iba pang provider. 4. Pumili ng default na modelo.
2. 5. **Workspace** — Lokasyon para sa mga agent file (default `~/.openclaw/workspace`). 14. Nagsi-seed ng mga bootstrap file.
3. **Gateway** — Port, bind address, auth mode, Tailscale exposure.
4. **Channels** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles, o iMessage.
5. **Daemon** — Nag-i-install ng LaunchAgent (macOS) o systemd user unit (Linux/WSL2).
6. **Health check** — Sinisimulan ang Gateway at tine-verify na ito ay tumatakbo.
7. **Skills** — Nag-i-install ng mga inirerekomendang skills at mga opsyonal na dependency.

<Note>
15. Ang muling pagpapatakbo ng wizard ay **hindi** nagbubura ng anuman maliban kung tahasan mong piliin ang **Reset** (o ipasa ang `--reset`).
8. Kung hindi wasto ang config o may mga legacy key, hihilingin ng wizard na patakbuhin mo muna ang `openclaw doctor`.
</Note>

9. **Remote mode** ay kino-configure lamang ang lokal na client para kumonekta sa isang Gateway sa ibang lugar.
10. **Hindi** ito nag-i-install o nagbabago ng anuman sa remote host.

## Magdagdag ng isa pang agent

11. Gamitin ang `openclaw agents add <name>` para lumikha ng hiwalay na agent na may sariling workspace, mga session, at auth profile. 12. Ang pagpapatakbo nang walang `--workspace` ay naglulunsad ng wizard.

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
