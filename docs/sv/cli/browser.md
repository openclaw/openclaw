---
summary: "CLI-referens för `openclaw browser` (profiler, flikar, åtgärder, tilläggsrelä)"
read_when:
  - Du använder `openclaw browser` och vill ha exempel på vanliga uppgifter
  - Du vill styra en webbläsare som körs på en annan maskin via en node host
  - Du vill använda Chrome-tilläggsreläet (anslut/koppla från via verktygsfältsknappen)
title: "browser"
---

# `openclaw browser`

Hantera OpenClaws server för webbläsarstyrning och kör webbläsaråtgärder (flikar, snapshots, skärmdumpar, navigering, klick, inmatning).

Relaterat:

- Webbläsarverktyg + API: [Browser tool](/tools/browser)
- Chrome-tilläggsrelä: [Chrome extension](/tools/chrome-extension)

## Vanliga flaggor

- `--url <gatewayWsUrl>`: Gateway WebSocket-URL (standard enligt konfig).
- `--token <token>`: Gateway-token (om det krävs).
- `--timeout <ms>`: tidsgräns för begäran (ms).
- `--browser-profile <name>`: välj en webbläsarprofil (standard från konfig).
- `--json`: maskinläsbar utdata (där det stöds).

## Snabbstart (lokalt)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profiler

Profiler namnges webbläsare routing konfigurationer. I praktiken:

- `openclaw`: startar/ansluter till en dedikerad OpenClaw-hanterad Chrome-instans (isolerad användardatakatalog).
- `chrome`: styr dina befintliga Chrome-flikar via Chrome-tilläggsreläet.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Använd en specifik profil:

```bash
openclaw browser --browser-profile work tabs
```

## Flikar

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / skärmdump / åtgärder

Snapshot:

```bash
openclaw browser snapshot
```

Skärmdump:

```bash
openclaw browser screenshot
```

Navigera/klicka/skriv (referensbaserad UI-automatisering):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome-tilläggsrelä (anslut via verktygsfältsknappen)

Detta läge låter agenten styra en befintlig Chrome-flik som du ansluter manuellt (den ansluter inte automatiskt).

Installera det opackade tillägget till en stabil sökväg:

```bash
openclaw browser extension install
openclaw browser extension path
```

Gå sedan till Chrome → `chrome://extensions` → aktivera ”Developer mode” → ”Load unpacked” → välj den utskrivna mappen.

Fullständig guide: [Chrome extension](/tools/chrome-extension)

## Fjärrstyrning av webbläsare (node host-proxy)

Om Gateway körs på en annan maskin än webbläsaren, kör en **nod värd** på maskinen som har Chrome/Brave/Edge/Chromium. Gateway kommer proxy webbläsare åtgärder till den noden (ingen separat webbläsare kontrollserver krävs).

Använd `gateway.nodes.browser.mode` för att styra automatisk routning och `gateway.nodes.browser.node` för att låsa till en specifik nod om flera är anslutna.

Säkerhet + fjärrkonfiguration: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
