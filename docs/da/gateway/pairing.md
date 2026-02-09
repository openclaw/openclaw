---
summary: "Gateway-ejet nodeparring (Mulighed B) til iOS og andre fjernnoder"
read_when:
  - Implementering af godkendelser for nodeparring uden macOS-UI
  - Tilføjelse af CLI-flows til godkendelse af fjernnoder
  - Udvidelse af gateway-protokollen med nodehåndtering
title: "Gateway-ejet parring"
---

# Gateway-ejet parring (Mulighed B)

I Gateway-ejet parring er **Gateway** den kilde til sandhed, som indholdselementer
får lov til at deltage i. UI'er (macOS app, fremtidige kunder) er bare frontends at
godkende eller afvise afventende anmodninger.

**Vigtigt:** WS noder bruger **enhedsparring** (rolle `node`) under `forbindelse`.
`node.pair.*` er en separat parring butik og gør **ikke** gate WS håndtryk.
Kun kunder, der udtrykkeligt kalder `node.pair.*` bruger denne flow.

## Begreber

- **Ventende anmodning**: en node har anmodet om at tilslutte sig; kræver godkendelse.
- **Parret node**: godkendt node med et udstedt auth-token.
- **Transport**: Gateway WS-endepunktet viderestiller anmodninger, men beslutter ikke et
  -medlemskab. (Legacy TCP bridge support er forældet/fjernet.)

## Sådan fungerer parring

1. En node forbinder til Gateway WS og anmoder om parring.
2. Gateway gemmer en **ventende anmodning** og udsender `node.pair.requested`.
3. Du godkender eller afviser anmodningen (CLI eller UI).
4. Ved godkendelse udsteder Gateway et **nyt token** (tokens roteres ved omparring).
5. Noden genforbinder med tokenet og er nu “parret”.

Ventende anmodninger udløber automatisk efter **5 minutter**.

## CLI-arbejdsgang (headless-venlig)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` viser parrede/forbundne noder og deres kapabiliteter.

## API-overflade (gateway-protokol)

Hændelser:

- `node.pair.requested` — udsendes, når en ny ventende anmodning oprettes.
- `node.pair.resolved` — udsendes, når en anmodning godkendes/afvises/udløber.

Metoder:

- `node.pair.request` — opret eller genbrug en ventende anmodning.
- `node.pair.list` — list ventende + parrede noder.
- `node.pair.approve` — godkend en ventende anmodning (udsteder token).
- `node.pair.reject` — afvis en ventende anmodning.
- `node.pair.verify` — verificér `{ nodeId, token }`.

Noter:

- `node.pair.request` er idempotent pr. node: gentagne kald returnerer den samme
  ventende anmodning.
- Godkendelse genererer **altid** et nyt token; intet token returneres nogensinde fra
  `node.pair.request`.
- Anmodninger kan inkludere `silent: true` som et hint til auto-godkendelsesflows.

## Auto-godkendelse (macOS-app)

macOS-appen kan valgfrit forsøge en **stille godkendelse**, når:

- anmodningen er markeret `silent`, og
- appen kan verificere en SSH-forbindelse til gateway-værten med samme bruger.

Hvis stille godkendelse mislykkes, falder den tilbage til den normale “Godkend/Afvis”-prompt.

## Lagring (lokal, privat)

Parringstilstand gemmes under Gateway-tilstandskataloget (standard `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

Hvis du tilsidesætter `OPENCLAW_STATE_DIR`, flytter `nodes/`-mappen med.

Sikkerhedsnoter:

- Tokens er hemmeligheder; behandl `paired.json` som følsomt.
- Rotering af et token kræver gen-godkendelse (eller sletning af nodeposten).

## Transportadfærd

- Transporten er **tilstandsløs**; den gemmer ikke medlemskab.
- Hvis Gateway er offline, eller parring er deaktiveret, kan noder ikke parre.
- Hvis Gateway er i fjern-tilstand, sker parring stadig mod den fjerne Gateways lager.
