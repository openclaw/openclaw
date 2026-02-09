---
summary: "CLI-referentie voor `openclaw browser` (profielen, tabbladen, acties, extensierelay)"
read_when:
  - Je gebruikt `openclaw browser` en wilt voorbeelden voor veelvoorkomende taken
  - Je wilt een browser die op een andere machine draait bedienen via een node-host
  - Je wilt de Chrome-extensierelay gebruiken (koppelen/ontkoppelen via de werkbalkknop)
title: "browser"
---

# `openclaw browser`

Beheer de browserbesturingsserver van OpenClaw en voer browseracties uit (tabbladen, snapshots, screenshots, navigatie, klikken, typen).

Gerelateerd:

- Browser tool + API: [Browser tool](/tools/browser)
- Chrome-extensierelay: [Chrome extension](/tools/chrome-extension)

## Veelgebruikte flags

- `--url <gatewayWsUrl>`: Gateway WebSocket-URL (standaard uit config).
- `--token <token>`: Gateway-token (indien vereist).
- `--timeout <ms>`: time-out voor verzoeken (ms).
- `--browser-profile <name>`: kies een browserprofiel (standaard uit config).
- `--json`: machineleesbare uitvoer (waar ondersteund).

## Snelle start (lokaal)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profielen

Profielen zijn benoemde browser-routeringsconfiguraties. In de praktijk:

- `openclaw`: start/koppelt aan een speciale, door OpenClaw beheerde Chrome-instantie (geïsoleerde gebruikersdatamap).
- `chrome`: bedient je bestaande Chrome-tabblad(en) via de Chrome-extensierelay.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Gebruik een specifiek profiel:

```bash
openclaw browser --browser-profile work tabs
```

## Tabbladen

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / screenshot / acties

Snapshot:

```bash
openclaw browser snapshot
```

Screenshot:

```bash
openclaw browser screenshot
```

Navigeren/klikken/typen (ref-gebaseerde UI-automatisering):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome-extensierelay (koppelen via werkbalkknop)

Met deze modus kan de agent een bestaand Chrome-tabblad bedienen dat je handmatig koppelt (er wordt niet automatisch gekoppeld).

Installeer de ongepakte extensie naar een stabiel pad:

```bash
openclaw browser extension install
openclaw browser extension path
```

Ga vervolgens in Chrome naar → `chrome://extensions` → schakel “Developer mode” in → “Load unpacked” → selecteer de afgedrukte map.

Volledige handleiding: [Chrome extension](/tools/chrome-extension)

## Browser op afstand bedienen (node-hostproxy)

Als de Gateway op een andere machine draait dan de browser, voer dan een **node host** uit op de machine met Chrome/Brave/Edge/Chromium. De Gateway proxyt browseracties naar die node (geen aparte browserbesturingsserver vereist).

Gebruik `gateway.nodes.browser.mode` om auto-routering te regelen en `gateway.nodes.browser.node` om een specifieke node vast te pinnen als er meerdere verbonden zijn.

Beveiliging + externe installatie: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
