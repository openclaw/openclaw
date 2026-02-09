---
summary: "macOS-appflow til styring af en fjern OpenClaw gateway over SSH"
read_when:
  - Opsætning eller fejlfinding af fjern mac-styring
title: "Fjernstyring"
---

# Fjern OpenClaw (macOS ⇄ fjern vært)

Dette flow lader macOS app fungere som en fuld fjernbetjening for en OpenClaw gateway kører på en anden vært (desktop/server). Det er appens \*\* Remote over SSH \*\* (remote run) funktion. Alle funktioner-sundhedskontrol, Voice Wake forwarding, og Web Chat-genbrug den samme eksterne SSH-konfiguration fra _Settings → Generelt_.

## Tilstande

- **Lokal (denne Mac)**: Alt kører på den bærbare computer. Ingen SSH involveret.
- **Fjernbetjening over SSH (standard)**: OpenClaw kommandoer udføres på den eksterne vært. MAC-appen åbner en SSH-forbindelse med `-o BatchMode` plus din valgte identitet/nøgle og en lokal port-forward.
- **Fjernbetjening direkte (ws/wss)**: Ingen SSH-tunnel. Mac-appen forbinder direkte til gateway-URL'en (for eksempel via Tailscale Serve eller en offentlig HTTPS-omvendt proxy).

## Fjerntransporter

Remote-tilstand understøtter to transporter:

- **SSH-tunnel** (standard): Bruger `ssh -N -L ...` til at videresende porten til localhost. Porten vil se knudepunktets IP som '127.0.0.1', fordi tunnelen er loopback.
- **Direkte (ws/wss)**: Tilsluttes direkte til gateway URL. Porten ser den virkelige kunde IP.

## Forudsætninger på den fjerne vært

1. Installér Node + pnpm og byg/installér OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`).
2. Sørg for, at `openclaw` er på PATH for ikke-interaktive skaller (symlink til `/usr/local/bin` eller `/opt/homebrew/bin` hvis det er nødvendigt).
3. Åbn SSH med nøgle auth. Vi anbefaler **Tailscale** IP'er til stabil opnåelighed uden for LAN.

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
3. Slå **Test fjern**. Succes indikerer fjernbetjeningen 'openclaw status --json' kører korrekt. Fejl normalt betyde PATH / CLI spørgsmål; exit 127 betyder CLI er ikke fundet eksternt.
4. Sundhedstjek og Web Chat kører nu automatisk gennem denne SSH-tunnel.

## Web Chat

- **SSH-tunnel**: Web Chat forbinder til gatewayen over den forwarded WebSocket-kontrolport (standard 18789).
- **Direkte (ws/wss)**: Web Chat forbinder direkte til den konfigurerede gateway-URL.
- Der er ikke længere en separat WebChat HTTP-server.

## Tilladelser

- Den eksterne vært har brug for de samme TCC-godkendelser som den lokale, tilgængelighed, skærmoptagelse, mikrofon, talegenkendelse, meddelelser). Kør onboarding på denne maskine for at give dem én gang.
- Noder annoncerer deres tilladelsestilstand via `node.list` / `node.describe`, så agenter ved, hvad der er tilgængeligt.

## Sikkerhedsnoter

- Foretræk loopback-bindinger på den fjerne vært og forbind via SSH eller Tailscale.
- Hvis du binder Gateway til et ikke-loopback-interface, kræv token-/adgangskodeautentificering.
- Se [Sikkerhed](/gateway/security) og [Tailscale](/gateway/tailscale).

## WhatsApp-loginflow (remote)

- Kør `openclaw kanaler login --verbose` **på den eksterne vært**. Scan QR med WhatsApp på din telefon.
- Genkør login på denne vært, hvis auth udløber. Sundhedstjekket vil forbinde problemer.

## Fejlfinding

- **exit 127 / not found**: `openclaw` er ikke på PATH for ikke-login skaller. Tilføj den til `/etc/paths`, din shell rc, eller symlink til `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: tjek SSH-tilgængelighed, PATH, og at Baileys er logget ind (`openclaw status --json`).
- **Web Chat sidder fast**: bekræft, at gatewayen kører på den fjerne vært, og at den forwarded port matcher gatewayens WS-port; UI’et kræver en sund WS-forbindelse.
- **Node IP viser 127.0.0.1**: forventet med SSH-tunnelen. Skift **Transport** til **Direkte (ws/wss)** hvis du vil have gatewayen til at se den rigtige klient IP.
- **Voice Wake**: triggerfraser videresendes automatisk i remote-tilstand; ingen separat forwarder er nødvendig.

## Notifikationslyde

Vælg lyde pr. notifikation fra scripts med `openclaw` og `node.invoke`, f.eks.:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Der er ikke længere en global “standardlyd”-kontakt i appen; kaldere vælger en lyd (eller ingen) pr. anmodning.
