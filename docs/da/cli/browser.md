---
summary: "CLI-reference for `openclaw browser` (profiler, faner, handlinger, udvidelses-relay)"
read_when:
  - Du bruger `openclaw browser` og vil have eksempler på almindelige opgaver
  - Du vil styre en browser, der kører på en anden maskine via en node-vært
  - Du vil bruge Chrome-udvidelses-relayet (tilknyt/frakobl via værktøjslinjeknap)
title: "browser"
---

# `openclaw browser`

Administrér OpenClaws browser-kontrolserver og kør browserhandlinger (faner, snapshots, skærmbilleder, navigation, klik, indtastning).

Relateret:

- Browser-værktøj + API: [Browser tool](/tools/browser)
- Chrome-udvidelses-relay: [Chrome extension](/tools/chrome-extension)

## Almindelige flag

- `--url <gatewayWsUrl>`: Gateway WebSocket-URL (standard fra konfiguration).
- `--token <token>`: Gateway-token (hvis påkrævet).
- `--timeout <ms>`: timeout for anmodning (ms).
- `--browser-profile <name>`: vælg en browserprofil (standard fra konfiguration).
- `--json`: maskinlæsbar output (hvor understøttet).

## Hurtig start (lokalt)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profiler

Profiler hedder browser routing configs. I praksis:

- `openclaw`: starter/tilknytter til en dedikeret OpenClaw-administreret Chrome-instans (isoleret brugerdatamappe).
- `chrome`: styrer dine eksisterende Chrome-faner via Chrome-udvidelses-relayet.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Brug en specifik profil:

```bash
openclaw browser --browser-profile work tabs
```

## Faner

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / skærmbillede / handlinger

Snapshot:

```bash
openclaw browser snapshot
```

Skærmbillede:

```bash
openclaw browser screenshot
```

Navigér/klik/indtast (ref-baseret UI-automatisering):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome-udvidelses-relay (tilknyt via værktøjslinjeknap)

Denne tilstand lader agenten styre en eksisterende Chrome-fane, som du tilknytter manuelt (den tilknytter ikke automatisk).

Installér den upakkede udvidelse til en stabil sti:

```bash
openclaw browser extension install
openclaw browser extension path
```

Derefter Chrome → `chrome://extensions` → aktivér “Developer mode” → “Load unpacked” → vælg den udskrevne mappe.

Fuld guide: [Chrome extension](/tools/chrome-extension)

## Fjernbrowserkontrol (node-vært-proxy)

Hvis Gateway kører på en anden maskine end browseren, skal du køre en **nodevært** på den maskine, der har Chrome/Brave/Edge/Chromium. Gateway vil proxy browser handlinger til denne node (ingen separat browser kontrol server påkrævet).

Brug `gateway.nodes.browser.mode` til at styre automatisk routing og `gateway.nodes.browser.node` til at fastgøre en specifik node, hvis flere er tilsluttet.

Sikkerhed + fjernopsætning: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
