---
summary: "Gateway-ägd nodparning (Alternativ B) för iOS och andra fjärrnoder"
read_when:
  - Implementerar godkännanden för nodparning utan macOS‑UI
  - Lägger till CLI‑flöden för att godkänna fjärrnoder
  - Utökar gateway‑protokollet med nodhantering
title: "Gateway‑ägd parning"
---

# Gateway‑ägd parning (Alternativ B)

I Gateway-ägda parning är **Gateway** källan till sanningen som noderna
tillåts ansluta sig till. UI (macOS-app, framtida klienter) är bara frontends som
godkänner eller avvisar väntande förfrågningar.

**Viktigt:** WS noder använder **enhet parning** (roll `node`) under `connect`.
`node.pair.*` är en separat parbutik och **inte** portar WS handskakning.
Endast klienter som uttryckligen anropar `node.pair.*` använder detta flöde.

## Begrepp

- **Väntande förfrågan**: en nod har begärt att få ansluta; kräver godkännande.
- **Parad nod**: godkänd nod med utfärdad autentiseringstoken.
- **Transport**: slutpunkten Gateway WS vidarebefordrar förfrågningar men bestämmer inte
  medlemskap. (Legacy TCP-bryggstöd är föråldrat/borttaget.)

## Så fungerar parning

1. En nod ansluter till Gateway‑WS och begär parning.
2. Gateway lagrar en **väntande förfrågan** och emitterar `node.pair.requested`.
3. Du godkänner eller avslår förfrågan (CLI eller UI).
4. Vid godkännande utfärdar Gateway en **ny token** (token roteras vid omparning).
5. Noden återansluter med token och är nu ”parad”.

Väntande förfrågningar upphör automatiskt efter **5 minuter**.

## CLI‑arbetsflöde (headless‑vänligt)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` visar parade/anslutna noder och deras kapabiliteter.

## API‑yta (gateway‑protokoll)

Händelser:

- `node.pair.requested` — emitteras när en ny väntande förfrågan skapas.
- `node.pair.resolved` — emitteras när en förfrågan godkänns/avslås/upphör.

Metoder:

- `node.pair.request` — skapa eller återanvänd en väntande förfrågan.
- `node.pair.list` — lista väntande + parade noder.
- `node.pair.approve` — godkänn en väntande förfrågan (utfärdar token).
- `node.pair.reject` — avslå en väntande förfrågan.
- `node.pair.verify` — verifiera `{ nodeId, token }`.

Noteringar:

- `node.pair.request` är idempotent per nod: upprepade anrop returnerar samma
  väntande förfrågan.
- Godkännande genererar **alltid** en ny token; ingen token returneras någonsin från
  `node.pair.request`.
- Förfrågningar kan inkludera `silent: true` som en ledtråd för flöden med automatisk godkännande.

## Automatisk godkännande (macOS‑app)

macOS‑appen kan valfritt försöka **tyst godkännande** när:

- förfrågan är markerad `silent`, och
- appen kan verifiera en SSH‑anslutning till gateway‑värden med samma användare.

Om tyst godkännande misslyckas faller den tillbaka till den normala prompten ”Godkänn/Avslå”.

## Lagring (lokal, privat)

Parningsstatus lagras under Gateway‑tillståndskatalogen (standard `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

Om du åsidosätter `OPENCLAW_STATE_DIR` flyttas mappen `nodes/` med den.

Säkerhetsnoteringar:

- Token är hemligheter; behandla `paired.json` som känsligt.
- Att rotera en token kräver omgodkännande (eller att nodposten tas bort).

## Transportbeteende

- Transporten är **tillståndslös**; den lagrar inte medlemskap.
- Om Gateway är offline eller parning är inaktiverad kan noder inte paras.
- Om Gateway är i fjärrläge sker parning fortfarande mot den fjärranslutna Gatewayns lagring.
