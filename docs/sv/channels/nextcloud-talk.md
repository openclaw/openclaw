---
summary: "Supportstatus, funktioner och konfiguration för Nextcloud Talk"
read_when:
  - Arbetar med kanalfunktioner för Nextcloud Talk
title: "Nextcloud Talk"
---

# Nextcloud Talk (plugin)

Status: stöds via plugin (webhook bot). Direktmeddelanden, rum, reaktioner och markdown-meddelanden stöds.

## Plugin krävs

Nextcloud Talk levereras som ett plugin och ingår inte i kärninstallationen.

Installera via CLI (npm-registret):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Lokal utcheckning (när du kör från ett git-repo):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Om du väljer Nextcloud Talk under konfigurering/introduktion och en git-utcheckning upptäcks,
erbjuder OpenClaw automatiskt den lokala installationssökvägen.

Detaljer: [Plugins](/tools/plugin)

## Snabbstart (nybörjare)

1. Installera pluginet Nextcloud Talk.

2. Skapa en bot på din Nextcloud-server:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Aktivera boten i mål-rummets inställningar.

4. Konfigurera OpenClaw:
   - Konfig: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Eller env: `NEXTCLOUD_TALK_BOT_SECRET` (endast standardkonto)

5. Starta om gatewayn (nätverksgateway) (eller slutför introduktionen).

Minimal konfig:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Noteringar

- Bots kan inte initiera DMs. Användaren måste meddela botten först.
- Webhook-URL:en måste vara nåbar av Gateway; ange `webhookPublicUrl` om du är bakom en proxy.
- Medieuppladdningar stöds inte av bot-API:t; media skickas som URL:er.
- Webhook-payloaden skiljer inte på DM och rum; ange `apiUser` + `apiPassword` för att aktivera uppslag av rumstyp (annars behandlas DM som rum).

## Åtkomstkontroll (DM)

- Standard: `channels.nextcloud-talk.dmPolicy = "pairing"`. Okända avsändare får en parningskod.
- Godkänn via:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Offentliga DM: `channels.nextcloud-talk.dmPolicy="open"` plus `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` matchar endast Nextcloud-användar-ID:n; visningsnamn ignoreras.

## Rum (grupper)

- Standard: `channels.nextcloud-talk.groupPolicy = "allowlist"` (omnämnandespärr).
- Tillåtelselista rum med `channels.nextcloud-talk.rooms`:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- För att inte tillåta några rum, håll tillåtelselistan tom eller ange `channels.nextcloud-talk.groupPolicy="disabled"`.

## Funktioner

| Funktion           | Status     |
| ------------------ | ---------- |
| Direktmeddelanden  | Stöds      |
| Rum                | Stöds      |
| Trådar             | Stöds inte |
| Media              | Endast URL |
| Reaktioner         | Stöds      |
| Inbyggda kommandon | Stöds inte |

## Konfigurationsreferens (Nextcloud Talk)

Fullständig konfiguration: [Konfiguration](/gateway/configuration)

Leverantörsalternativ:

- `channels.nextcloud-talk.enabled`: aktivera/inaktivera kanalstart.
- `channels.nextcloud-talk.baseUrl`: URL till Nextcloud-instansen.
- `channels.nextcloud-talk.botSecret`: botens delade hemlighet.
- `channels.nextcloud-talk.botSecretFile`: sökväg till hemlighetsfil.
- `channels.nextcloud-talk.apiUser`: API-användare för rumsuppslag (DM-detektering).
- `channels.nextcloud-talk.apiPassword`: API-/app-lösenord för rumsuppslag.
- `channels.nextcloud-talk.apiPasswordFile`: sökväg till API-lösenordsfil.
- `channels.nextcloud-talk.webhookPort`: port för webhook-lyssnare (standard: 8788).
- `channels.nextcloud-talk.webhookHost`: webhook-värd (standard: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: webhook-sökväg (standard: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: externt nåbar webhook-URL.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: DM allowlist (användar-ID). `open` kräver `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: grupp-tillåtelselista (användar-ID:n).
- `channels.nextcloud-talk.rooms`: inställningar per rum och tillåtelselista.
- `channels.nextcloud-talk.historyLimit`: historikgräns för grupper (0 inaktiverar).
- `channels.nextcloud-talk.dmHistoryLimit`: historikgräns för DM (0 inaktiverar).
- `channels.nextcloud-talk.dms`: åsidosättningar per DM (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: textstyckningsstorlek för utgående meddelanden (tecken).
- `channels.nextcloud-talk.chunkMode`: `length` (standard) eller `newline` för att dela på tomma rader (styckegränser) före längdindelning.
- `channels.nextcloud-talk.blockStreaming`: inaktivera blockstreaming för denna kanal.
- `channels.nextcloud-talk.blockStreamingCoalesce`: sammanslagningsjustering för blockstreaming.
- `channels.nextcloud-talk.mediaMaxMb`: inkommande medietak (MB).
