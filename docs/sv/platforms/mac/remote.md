---
summary: "macOS-appflöde för att styra en fjärransluten OpenClaw-gateway över SSH"
read_when:
  - Vid konfigurering eller felsökning av fjärrstyrning av Mac
title: "Fjärrstyrning"
---

# Fjärrstyrd OpenClaw (macOS ⇄ fjärrvärd)

Detta flöde låter macOS-appen fungera som en fullständig fjärrkontroll för en OpenClaw gateway som körs på en annan värd (desktop/server). Det är appens **Fjärrkontroll över SSH** (fjärrkörning) funktion. Alla funktioner-hälsokontroller, Voice Wake vidarebefordran och Web Chat—återanvända samma fjärr-SSH-konfiguration från _Settings → Allmänt_.

## Lägen

- **Lokal (denna Mac)**: Allt körs på den bärbara datorn. Ingen SSH inblandad.
- **Fjärrkontroll över SSH (standard)**: OpenClaw-kommandon körs på fjärrvärden. Mac-appen öppnar en SSH-anslutning med `-o BatchMode` plus din valda identitet/nyckel och en lokal port-forward.
- **Fjärrstyrning (ws/wss)**: Ingen SSH-tunnel. Mac-appen ansluter till gateway-URL direkt (till exempel via Tailscale Serve eller en offentlig HTTPS-omvänd proxy).

## Fjärrtransporter

Fjärrläge stöder två transporter:

- **SSH-tunnel** (standard): Använder `ssh -N -L ...` för att vidarebefordra porten till localhost. Gateway kommer att se nodens IP som `127.0.0.1` eftersom tunneln är loopback.
- **Direkt (ws/wss)**: Ansluter direkt till gateway URL. Gateway ser den verkliga klienten IP.

## Förutsättningar på fjärrvärden

1. Installera Node + pnpm och bygg/installera OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`).
2. Säkerställ att `openclaw` finns i PATH för icke-interaktiva skal (symlänka till `/usr/local/bin` eller `/opt/homebrew/bin` vid behov).
3. Öppna SSH med nyckelförfattare. Vi rekommenderar **Skräddarskala** IP-adresser för stabil räckvidd utanför LAN.

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
3. Träffa **Testa fjärrkontroll**. Framgång indikerar fjärr-`openclaw-status --json` körs korrekt. Misslyckanden innebär vanligtvis PATH / CLI-problem; avsluta 127 innebär att CLI inte hittas på distans.
4. Hälsokontroller och Web Chat kommer nu att köras automatiskt genom denna SSH-tunnel.

## Web Chat

- **SSH-tunnel**: Web Chat ansluter till gatewayen via den vidarebefordrade WebSocket-kontrollporten (standard 18789).
- **Direkt (ws/wss)**: Web Chat ansluter direkt till den konfigurerade gateway-URL:en.
- Det finns inte längre någon separat WebChat HTTP-server.

## Behörigheter

- Fjärrvärden behöver samma TCC-godkännanden som lokal (Automatisering, Tillgänglighet, Skärminspelning, Mikrofon, Taligenkänning, Meddelanden). Kör onboarding på den maskinen för att ge dem en gång.
- Noder annonserar sitt behörighetstillstånd via `node.list` / `node.describe` så att agenter vet vad som är tillgängligt.

## Säkerhetsnoteringar

- Föredra loopback-bindningar på fjärrvärden och anslut via SSH eller Tailscale.
- Om du binder Gateway till ett icke-loopback-gränssnitt, kräv token-/lösenordsautentisering.
- Se [Säkerhet](/gateway/security) och [Tailscale](/gateway/tailscale).

## WhatsApp-inloggningsflöde (fjärr)

- Kör `openclaw channels login --verbose` **på fjärrvärden**. Skanna QR med WhatsApp på telefonen.
- Starta om inloggning på den värden om auth upphör. Hälsokontrollen kommer att länka problemen.

## Felsökning

- **exit 127 / hittades inte**: `openclaw` finns inte på PATH för icke-inloggningsskal. Lägg till i `/etc/paths`, din shell rc eller symbolisk länk till `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: kontrollera SSH-åtkomst, PATH och att Baileys är inloggad (`openclaw status --json`).
- **Web Chat fastnar**: bekräfta att gatewayen körs på fjärrvärden och att den vidarebefordrade porten matchar gatewayens WS-port; gränssnittet kräver en frisk WS-anslutning.
- **Node IP visar 127.0.0.1**: förväntas med SSH-tunneln. Byt **Transport** till **Direkt (ws/wss)** om du vill att porten ska se den riktiga klientens IP.
- **Voice Wake**: triggerfraser vidarebefordras automatiskt i fjärrläge; ingen separat vidarebefordrare behövs.

## Notisljud

Välj ljud per notis från skript med `openclaw` och `node.invoke`, till exempel:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Det finns inte längre någon global växling för ”standardljud” i appen; anropare väljer ett ljud (eller inget) per begäran.
