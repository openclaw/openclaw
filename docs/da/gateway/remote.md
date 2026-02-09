---
summary: "Fjernadgang via SSH-tunneler (Gateway WS) og tailnets"
read_when:
  - Kørsel eller fejlfinding af fjernopsætninger af gateway
title: "Fjernadgang"
---

# Fjernadgang (SSH, tunneler og tailnets)

Dette repo understøtter “fjern over SSH” ved at holde en enkelt Gateway (masteren) kørende på en dedikeret vært (desktop/server) og forbinde klienter til den.

- For **operatører (dig / macOS-appen)**: SSH-tunneling er den universelle fallback.
- For **noder (iOS/Android og fremtidige enheder)**: forbind til Gateway **WebSocket** (LAN/tailnet eller SSH-tunnel efter behov).

## Kerneideen

- Gateway WebSocket binder til **loopback** på din konfigurerede port (standard er 18789).
- Til fjernbrug videresender du den loopback-port over SSH (eller bruger et tailnet/VPN og tunneler mindre).

## Almindelige VPN/tailnet-opsætninger (hvor agenten bor)

Tænk på **Gatewayens vært** som “hvor agenten bor.” Det ejer sessioner, auth profiler, kanaler og tilstand.
Din bærbare computer / desktop (og knudepunkter) oprette forbindelse til denne vært.

### 1. Altid-tændt Gateway i dit tailnet (VPS eller hjemmeserver)

Kør Gateway på en persistent vært og nå den via **Tailscale** eller SSH.

- **Bedste UX:** behold `gateway.bind: "loopback"` og brug **Tailscale Serve** til Control UI.
- **Fallback:** behold loopback + SSH-tunnel fra enhver maskine, der har brug for adgang.
- **Eksempler:** [exe.dev](/install/exe-dev) (nem VM) eller [Hetzner](/install/hetzner) (produktions-VPS).

Dette er ideelt, når din laptop ofte sover, men du vil have agenten altid tændt.

### 2. Hjemme-desktop kører Gateway, laptop er fjernbetjening

Den bærbare computer kører **ikke** agent. Det forbinder eksternt:

- Brug macOS-appens **Remote over SSH**-tilstand (Indstillinger → Generelt → “OpenClaw runs”).
- Appen åbner og administrerer tunnelen, så WebChat + helbredstjek “bare virker”.

Runbook: [macOS fjernadgang](/platforms/mac/remote).

### 3. Laptop kører Gateway, fjernadgang fra andre maskiner

Behold Gateway lokalt, men eksponér den sikkert:

- SSH-tunnel til laptoppen fra andre maskiner, eller
- Tailscale Serve Control UI og behold Gateway kun på loopback.

Guide: [Tailscale](/gateway/tailscale) og [Web-overblik](/web).

## Kommandoflow (hvad kører hvor)

En gateway service ejer stat + kanaler. Knuder er periferie.

Flow-eksempel (Telegram → node):

- Telegram-besked ankommer til **Gateway**.
- Gateway kører **agenten** og beslutter, om der skal kaldes et node-værktøj.
- Gateway kalder **noden** over Gateway WebSocket (`node.*` RPC).
- Noden returnerer resultatet; Gateway svarer tilbage til Telegram.

Noter:

- **Noder kører ikke gateway-tjenesten.** Kun én gateway bør køre pr. vært, medmindre du bevidst kører isolerede profiler (se [Flere gateways](/gateway/multiple-gateways)).
- macOS-appens “node mode” er blot en nodeklient over Gateway WebSocket.

## SSH-tunnel (CLI + værktøjer)

Opret en lokal tunnel til den fjerne Gateway WS:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Med tunnelen oppe:

- `openclaw health` og `openclaw status --deep` når nu den fjerne gateway via `ws://127.0.0.1:18789`.
- `openclaw gateway {status,health,send,agent,call}` kan også målrette den videresendte URL via `--url` efter behov.

Bemærk: Udskift `18789` med din konfigurerede `gateway.port` (eller `--port`/`OPENCLAW_GATEWAY_PORT`).
Bemærk: Når du passerer `--url`, CLI ikke falder tilbage til config eller miljø legitimationsoplysninger.
Inkludér `--token` eller `--password` eksplicit. Manglende eksplicitte legitimationsoplysninger er en fejl.

## CLI-fjernstandarder

Du kan gemme et fjernmål, så CLI-kommandoer bruger det som standard:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

Når gatewayen er loopback-only, behold URL’en på `ws://127.0.0.1:18789` og åbn SSH-tunnelen først.

## Chat UI over SSH

WebChat bruger ikke længere en separat HTTP-port. SwiftUI chat UI forbinder direkte til Gateway WebSocket.

- Videresend `18789` over SSH (se ovenfor), og forbind derefter klienter til `ws://127.0.0.1:18789`.
- På macOS foretrækkes appens “Remote over SSH”-tilstand, som automatisk administrerer tunnelen.

## macOS-app “Remote over SSH”

macOS-menuapplikationen kan drive den samme opsætning ende-til-ende (fjernstatuschecks, WebChat og Voice Wake-videresendelse).

Runbook: [macOS fjernadgang](/platforms/mac/remote).

## Sikkerhedsregler (fjern/VPN)

Kort version: **behold Gateway loopback-only**, medmindre du er sikker på, at du har brug for et bind.

- **Loopback + SSH/Tailscale Serve** er den sikreste standard (ingen offentlig eksponering).
- **Ikke-loopback binds** (`lan`/`tailnet`/`custom` eller `auto`, når loopback er utilgængelig) skal bruge auth-tokens/adgangskoder.
- `gateway.remote.token` er **kun** til fjern-CLI-kald — det **aktiverer ikke** lokal auth.
- `gateway.remote.tlsFingerprint` fastlåser det fjerne TLS-certifikat, når `wss://` bruges.
- **Tailscale Serve** kan autentificere via identitetsoverskrifter, når `gateway.auth.allowTailscale: true`.
  Sæt den til `false` hvis du ønsker tokens/adgangskoder i stedet.
- Behandl browserkontrol som operatøradgang: kun tailnet + bevidst node-parring.

Dybdegående gennemgang: [Sikkerhed](/gateway/security).
