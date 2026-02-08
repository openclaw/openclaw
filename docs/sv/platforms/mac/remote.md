---
summary: "macOS-appflöde för att styra en fjärransluten OpenClaw-gateway över SSH"
read_when:
  - Vid konfigurering eller felsökning av fjärrstyrning av Mac
title: "Fjärrstyrning"
x-i18n:
  source_path: platforms/mac/remote.md
  source_hash: 61b43707250d5515
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:05Z
---

# Fjärrstyrd OpenClaw (macOS ⇄ fjärrvärd)

Detta flöde låter macOS-appen fungera som en fullständig fjärrkontroll för en OpenClaw-gateway som körs på en annan värd (desktop/server). Det är appens funktion **Remote over SSH** (fjärrkörning). Alla funktioner – hälsokontroller, vidarebefordran av Voice Wake och Web Chat – återanvänder samma fjärr-SSH-konfiguration från _Inställningar → Allmänt_.

## Lägen

- **Lokalt (den här Macen)**: Allt körs på den bärbara datorn. Ingen SSH används.
- **Fjärr över SSH (standard)**: OpenClaw-kommandon körs på fjärrvärden. Mac-appen öppnar en SSH-anslutning med `-o BatchMode` samt din valda identitet/nyckel och en lokal portvidarebefordran.
- **Fjärr direkt (ws/wss)**: Ingen SSH-tunnel. Mac-appen ansluter direkt till gateway-URL:en (till exempel via Tailscale Serve eller en publik HTTPS-reverse proxy).

## Fjärrtransporter

Fjärrläge stöder två transporter:

- **SSH-tunnel** (standard): Använder `ssh -N -L ...` för att vidarebefordra gateway-porten till localhost. Gatewayen kommer att se nodens IP som `127.0.0.1` eftersom tunneln är loopback.
- **Direkt (ws/wss)**: Ansluter direkt till gateway-URL:en. Gatewayen ser den verkliga klient-IP:n.

## Förutsättningar på fjärrvärden

1. Installera Node + pnpm och bygg/installera OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`).
2. Säkerställ att `openclaw` finns i PATH för icke-interaktiva skal (symlänka till `/usr/local/bin` eller `/opt/homebrew/bin` vid behov).
3. Öppna SSH med nyckelautentisering. Vi rekommenderar **Tailscale**-IP:er för stabil åtkomst utanför LAN.

## Konfigurering i macOS-appen

1. Öppna _Inställningar → Allmänt_.
2. Under **OpenClaw körs**, välj **Fjärr över SSH** och ange:
   - **Transport**: **SSH-tunnel** eller **Direkt (ws/wss)**.
   - **SSH-mål**: `user@host` (valfritt `:port`).
     - Om gatewayen finns på samma LAN och annonserar via Bonjour, välj den från den upptäckta listan för att automatiskt fylla i detta fält.
   - **Gateway-URL** (endast Direkt): `wss://gateway.example.ts.net` (eller `ws://...` för lokal/LAN).
   - **Identitetsfil** (avancerat): sökväg till din nyckel.
   - **Projektrot** (avancerat): fjärrens checkout-sökväg som används för kommandon.
   - **CLI-sökväg** (avancerat): valfri sökväg till en körbar `openclaw`-entrypoint/binär (fylls i automatiskt när den annonseras).
3. Klicka på **Testa fjärr**. Framgång indikerar att den fjärranslutna `openclaw status --json` körs korrekt. Fel beror oftast på PATH/CLI-problem; exit 127 betyder att CLI:t inte hittas på fjärren.
4. Hälsokontroller och Web Chat kommer nu att köras automatiskt genom denna SSH-tunnel.

## Web Chat

- **SSH-tunnel**: Web Chat ansluter till gatewayen via den vidarebefordrade WebSocket-kontrollporten (standard 18789).
- **Direkt (ws/wss)**: Web Chat ansluter direkt till den konfigurerade gateway-URL:en.
- Det finns inte längre någon separat WebChat HTTP-server.

## Behörigheter

- Fjärrvärden behöver samma TCC-godkännanden som lokalt (Automation, Hjälpmedel, Skärminspelning, Mikrofon, Taligenkänning, Notiser). Kör introduktionen på den maskinen för att bevilja dem en gång.
- Noder annonserar sitt behörighetstillstånd via `node.list` / `node.describe` så att agenter vet vad som är tillgängligt.

## Säkerhetsnoteringar

- Föredra loopback-bindningar på fjärrvärden och anslut via SSH eller Tailscale.
- Om du binder Gateway till ett icke-loopback-gränssnitt, kräv token-/lösenordsautentisering.
- Se [Säkerhet](/gateway/security) och [Tailscale](/gateway/tailscale).

## WhatsApp-inloggningsflöde (fjärr)

- Kör `openclaw channels login --verbose` **på fjärrvärden**. Skanna QR-koden med WhatsApp på din telefon.
- Kör inloggningen igen på den värden om autentiseringen löper ut. Hälsokontrollen kommer att visa länkproblem.

## Felsökning

- **exit 127 / not found**: `openclaw` finns inte i PATH för icke-inloggningsskal. Lägg till det i `/etc/paths`, din shell rc, eller symlänka till `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: kontrollera SSH-åtkomst, PATH och att Baileys är inloggad (`openclaw status --json`).
- **Web Chat fastnar**: bekräfta att gatewayen körs på fjärrvärden och att den vidarebefordrade porten matchar gatewayens WS-port; gränssnittet kräver en frisk WS-anslutning.
- **Node-IP visar 127.0.0.1**: förväntat med SSH-tunneln. Byt **Transport** till **Direkt (ws/wss)** om du vill att gatewayen ska se den verkliga klient-IP:n.
- **Voice Wake**: triggerfraser vidarebefordras automatiskt i fjärrläge; ingen separat vidarebefordrare behövs.

## Notisljud

Välj ljud per notis från skript med `openclaw` och `node.invoke`, till exempel:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Det finns inte längre någon global växling för ”standardljud” i appen; anropare väljer ett ljud (eller inget) per begäran.
