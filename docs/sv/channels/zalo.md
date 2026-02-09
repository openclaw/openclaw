---
summary: "Status, funktioner och konfiguration för stöd av Zalo-bot"
read_when:
  - Arbetar med Zalo-funktioner eller webhooks
title: "Zalo"
---

# Zalo (Bot API)

Status: experimentell. Direkta meddelanden endast, grupper kommer snart per Zalo docs.

## Plugin krävs

Zalo levereras som ett plugin och ingår inte i kärninstallationen.

- Installera via CLI: `openclaw plugins install @openclaw/zalo`
- Eller välj **Zalo** under introduktionen och bekräfta installationsprompten
- Detaljer: [Plugins](/tools/plugin)

## Snabb konfigurering (nybörjare)

1. Installera Zalo-pluginet:
   - Från en källutcheckning: `openclaw plugins install ./extensions/zalo`
   - Från npm (om publicerad): `openclaw plugins install @openclaw/zalo`
   - Eller välj **Zalo** i introduktionen och bekräfta installationsprompten
2. Ställ in token:
   - Env: `ZALO_BOT_TOKEN=...`
   - Eller konfig: `channels.zalo.botToken: "..."`.
3. Starta om gatewayn (eller slutför introduktionen).
4. DM-åtkomst är parning som standard; godkänn parningskoden vid första kontakt.

Minimal konfig:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## Vad det är

Zalo är en vietnam-fokuserad meddelandeapp; dess Bot API låter Gateway köra en bot för 1:1 konversationer.
Det är en bra passform för stöd eller meddelanden där du vill ha deterministisk dirigering tillbaka till Zalo.

- En Zalo Bot API-kanal som ägs av Gateway.
- Deterministisk routning: svar går tillbaka till Zalo; modellen väljer aldrig kanaler.
- DM delar agentens huvudsession.
- Grupper stöds ännu inte (Zalo-dokumentationen anger ”kommer snart”).

## Konfigurering (snabb väg)

### 1. Skapa en bottoken (Zalo Bot Platform)

1. Gå till [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) och logga in.
2. Skapa en ny bot och konfigurera dess inställningar.
3. Kopiera bottoken (format: `12345689:abc-xyz`).

### 2) Konfigurera token (env eller konfig)

Exempel:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

Env-alternativ: `ZALO_BOT_TOKEN=...` (fungerar endast för standardkontot).

Stöd för flera konton: använd `channels.zalo.accounts` med per-konto-token och valfri `name`.

3. Starta om gatewayn. Zalo startar när en token är löst (env eller config).
4. DM åtkomststandard är att para. Godkänn koden när botten först kontaktas.

## Hur det fungerar (beteende)

- Inkommande meddelanden normaliseras till det delade kanalhöljet med medieplatshållare.
- Svar routas alltid tillbaka till samma Zalo-chatt.
- Long-polling som standard; webhook-läge finns med `channels.zalo.webhookUrl`.

## Begränsningar

- Utgående text delas upp i 2000 tecken (Zalo API-gräns).
- Nedladdning/uppladdning av media begränsas av `channels.zalo.mediaMaxMb` (standard 5).
- Streaming blockeras som standard eftersom 2000-teckensgränsen gör streaming mindre användbar.

## Åtkomstkontroll (DM)

### DM-åtkomst

- Standard: `channels.zalo.dmPolicy = "pairing"`. Okända avsändare får en parningskod; meddelanden ignoreras tills de godkänts (koder upphör efter 1 timme).
- Godkänn via:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- Parkoppling är standard token exchange. Detaljer: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` accepterar numeriska användar-ID:n (ingen uppslagning av användarnamn finns).

## Long-polling vs webhook

- Standard: long-polling (ingen publik URL krävs).
- Webhook-läge: sätt `channels.zalo.webhookUrl` och `channels.zalo.webhookSecret`.
  - Webhook-hemligheten måste vara 8–256 tecken.
  - Webhook-URL måste använda HTTPS.
  - Zalo skickar händelser med rubriken `X-Bot-Api-Secret-Token` för verifiering.
  - Gateway HTTP hanterar webhook-förfrågningar på `channels.zalo.webhookPath` (standard är webhook-URL:ens sökväg).

**Obs:** getUpdates (polling) och webhook är ömsesidigt uteslutande enligt Zalo API-dokumentationen.

## Stödda meddelandetyper

- **Textmeddelanden**: Fullt stöd med uppdelning i 2000 tecken.
- **Bildmeddelanden**: Ladda ned och bearbeta inkommande bilder; skicka bilder via `sendPhoto`.
- **Dekaler**: Loggas men bearbetas inte fullt ut (ingen agentrespons).
- **Icke stödda typer**: Loggas (t.ex. meddelanden från skyddade användare).

## Funktioner

| Funktion                          | Status                                                          |
| --------------------------------- | --------------------------------------------------------------- |
| Direktmeddelanden                 | ✅ Stöds                                                         |
| Grupper                           | ❌ Kommer snart (enligt Zalo-dokumentationen) |
| Media (bilder) | ✅ Stöds                                                         |
| Reaktioner                        | ❌ Stöds inte                                                    |
| Trådar                            | ❌ Stöds inte                                                    |
| Omröstningar                      | ❌ Stöds inte                                                    |
| Inbyggda kommandon                | ❌ Stöds inte                                                    |
| Streaming                         | ⚠️ Blockerad (2000-teckensgräns)             |

## Leveransmål (CLI/cron)

- Använd ett chatt-ID som mål.
- Exempel: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Felsökning

**Boten svarar inte:**

- Kontrollera att token är giltig: `openclaw channels status --probe`
- Verifiera att avsändaren är godkänd (parning eller allowFrom)
- Kontrollera gateway-loggar: `openclaw logs --follow`

**Webhook tar inte emot händelser:**

- Säkerställ att webhook-URL använder HTTPS
- Verifiera att hemlig token är 8–256 tecken
- Bekräfta att gatewayns HTTP-ändpunkt är nåbar på den konfigurerade sökvägen
- Kontrollera att getUpdates-polling inte körs (de är ömsesidigt uteslutande)

## Konfigurationsreferens (Zalo)

Fullständig konfiguration: [Konfiguration](/gateway/configuration)

Leverantörsalternativ:

- `channels.zalo.enabled`: aktivera/inaktivera kanalstart.
- `channels.zalo.botToken`: bottoken från Zalo Bot Platform.
- `channels.zalo.tokenFile`: läs token från filsökväg.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (standard: parning).
- `channels.zalo.allowFrom`: DM allowlist (användar-ID). `open` kräver `"*"`. Guiden kommer att be om numeriska ID.
- `channels.zalo.mediaMaxMb`: gräns för inkommande/utgående media (MB, standard 5).
- `channels.zalo.webhookUrl`: aktivera webhook-läge (HTTPS krävs).
- `channels.zalo.webhookSecret`: webhook-hemlighet (8–256 tecken).
- `channels.zalo.webhookPath`: webhook-sökväg på gatewayns HTTP-server.
- `channels.zalo.proxy`: proxy-URL för API-anrop.

Alternativ för flera konton:

- `channels.zalo.accounts.<id>.botToken`: token per konto.
- `channels.zalo.accounts.<id>.tokenFile`: tokenfil per konto.
- `channels.zalo.accounts.<id>.name`: visningsnamn.
- `channels.zalo.accounts.<id>.enabled`: aktivera/inaktivera konto.
- `channels.zalo.accounts.<id>.dmPolicy`: DM-policy per konto.
- `channels.zalo.accounts.<id>.allowFrom`: Tillåten per konto.
- `channels.zalo.accounts.<id>.webhookUrl`: webhook-URL per konto.
- `channels.zalo.accounts.<id>.webhookSecret`: hemlighet per konto.
- `channels.zalo.accounts.<id>.webhookPath`: sökväg per konto
- `channels.zalo.accounts.<id>.proxy`: proxy per konto
