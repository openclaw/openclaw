---
summary: "macOS-appflow til styring af en fjern OpenClaw gateway over SSH"
read_when:
  - Opsætning eller fejlfinding af fjern mac-styring
title: "Fjernstyring"
x-i18n:
  source_path: platforms/mac/remote.md
  source_hash: 61b43707250d5515
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:35Z
---

# Fjern OpenClaw (macOS ⇄ fjern vært)

Dette flow lader macOS-appen fungere som en fuld fjernbetjening til en OpenClaw gateway, der kører på en anden vært (desktop/server). Det er appens **Remote over SSH** (fjernkørsel)-funktion. Alle funktioner—sundhedstjek, Voice Wake-videresendelse og Web Chat—genbruger den samme fjern-SSH-konfiguration fra _Indstillinger → Generelt_.

## Tilstande

- **Lokal (denne Mac)**: Alt kører på den bærbare. Ingen SSH involveret.
- **Remote over SSH (standard)**: OpenClaw-kommandoer udføres på den fjerne vært. Mac-appen åbner en SSH-forbindelse med `-o BatchMode` plus din valgte identitet/nøgle og en lokal port-forward.
- **Remote direct (ws/wss)**: Ingen SSH-tunnel. Mac-appen forbinder direkte til gateway-URL’en (f.eks. via Tailscale Serve eller en offentlig HTTPS reverse proxy).

## Fjerntransporter

Remote-tilstand understøtter to transporter:

- **SSH-tunnel** (standard): Bruger `ssh -N -L ...` til at forwarde gateway-porten til localhost. Gatewayen vil se nodens IP som `127.0.0.1`, fordi tunnelen er loopback.
- **Direkte (ws/wss)**: Forbinder direkte til gateway-URL’en. Gatewayen ser den rigtige klient-IP.

## Forudsætninger på den fjerne vært

1. Installér Node + pnpm og byg/installér OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`).
2. Sørg for, at `openclaw` er på PATH for ikke-interaktive shells (lav evt. et symlink til `/usr/local/bin` eller `/opt/homebrew/bin`).
3. Åbn SSH med nøgleautentificering. Vi anbefaler **Tailscale**-IP’er for stabil tilgængelighed uden for LAN.

## macOS-app opsætning

1. Åbn _Indstillinger → Generelt_.
2. Under **OpenClaw kører**, vælg **Remote over SSH**, og angiv:
   - **Transport**: **SSH-tunnel** eller **Direkte (ws/wss)**.
   - **SSH-mål**: `user@host` (valgfrit `:port`).
     - Hvis gatewayen er på samme LAN og annoncerer Bonjour, vælg den fra den opdagede liste for automatisk udfyldning af feltet.
   - **Gateway-URL** (kun Direkte): `wss://gateway.example.ts.net` (eller `ws://...` for lokal/LAN).
   - **Identitetsfil** (avanceret): sti til din nøgle.
   - **Projektrod** (avanceret): fjern-checkout-sti, der bruges til kommandoer.
   - **CLI-sti** (avanceret): valgfri sti til et kørbart `openclaw` entrypoint/binær (udfyldes automatisk, når den annonceres).
3. Klik på **Test remote**. Succes indikerer, at den fjerne `openclaw status --json` kører korrekt. Fejl betyder typisk PATH/CLI-problemer; exit 127 betyder, at CLI’en ikke findes på den fjerne vært.
4. Sundhedstjek og Web Chat kører nu automatisk gennem denne SSH-tunnel.

## Web Chat

- **SSH-tunnel**: Web Chat forbinder til gatewayen over den forwarded WebSocket-kontrolport (standard 18789).
- **Direkte (ws/wss)**: Web Chat forbinder direkte til den konfigurerede gateway-URL.
- Der er ikke længere en separat WebChat HTTP-server.

## Tilladelser

- Den fjerne vært kræver de samme TCC-godkendelser som lokalt (Automatisering, Hjælpemidler, Skærmoptagelse, Mikrofon, Talegenkendelse, Notifikationer). Kør introduktion på den maskine for at give dem én gang.
- Noder annoncerer deres tilladelsestilstand via `node.list` / `node.describe`, så agenter ved, hvad der er tilgængeligt.

## Sikkerhedsnoter

- Foretræk loopback-bindinger på den fjerne vært og forbind via SSH eller Tailscale.
- Hvis du binder Gateway til et ikke-loopback-interface, kræv token-/adgangskodeautentificering.
- Se [Sikkerhed](/gateway/security) og [Tailscale](/gateway/tailscale).

## WhatsApp-loginflow (remote)

- Kør `openclaw channels login --verbose` **på den fjerne vært**. Scan QR-koden med WhatsApp på din telefon.
- Kør login igen på den vært, hvis godkendelsen udløber. Sundhedstjek vil vise forbindelsesproblemer.

## Fejlfinding

- **exit 127 / not found**: `openclaw` er ikke på PATH for ikke-login-shells. Tilføj den til `/etc/paths`, din shell-rc, eller lav et symlink til `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: tjek SSH-tilgængelighed, PATH, og at Baileys er logget ind (`openclaw status --json`).
- **Web Chat sidder fast**: bekræft, at gatewayen kører på den fjerne vært, og at den forwarded port matcher gatewayens WS-port; UI’et kræver en sund WS-forbindelse.
- **Node-IP viser 127.0.0.1**: forventet med SSH-tunnelen. Skift **Transport** til **Direkte (ws/wss)**, hvis du vil have, at gatewayen ser den rigtige klient-IP.
- **Voice Wake**: triggerfraser videresendes automatisk i remote-tilstand; ingen separat forwarder er nødvendig.

## Notifikationslyde

Vælg lyde pr. notifikation fra scripts med `openclaw` og `node.invoke`, f.eks.:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Der er ikke længere en global “standardlyd”-kontakt i appen; kaldere vælger en lyd (eller ingen) pr. anmodning.
