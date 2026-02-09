---
summary: "Door de Gateway beheerde node-koppeling (Optie B) voor iOS en andere externe nodes"
read_when:
  - Implementeren van goedkeuringen voor node-koppeling zonder macOS-UI
  - Toevoegen van CLI-flows voor het goedkeuren van externe nodes
  - Uitbreiden van het gatewayprotocol met nodebeheer
title: "Door de Gateway beheerde koppeling"
---

# Door de Gateway beheerde koppeling (Optie B)

Bij door de Gateway beheerde koppeling is de **Gateway** de bron van waarheid voor welke nodes
mogen deelnemen. UI’s (macOS-app, toekomstige clients) zijn slechts front-ends die
openstaande aanvragen goedkeuren of afwijzen.

**Belangrijk:** WS-nodes gebruiken **apparaatkoppeling** (rol `node`) tijdens `connect`.
`node.pair.*` is een aparte koppelingsopslag en blokkeert de WS-handshake **niet**.
Alleen clients die expliciet `node.pair.*` aanroepen gebruiken deze flow.

## Concepten

- **Openstaande aanvraag**: een node die heeft gevraagd om toe te treden; vereist goedkeuring.
- **Gekoppelde node**: goedgekeurde node met een uitgegeven auth-token.
- **Transport**: het Gateway-WS-eindpunt stuurt aanvragen door maar beslist niet over
  lidmaatschap. (Ondersteuning voor legacy TCP-bridge is verouderd/verwijderd.)

## Hoe koppeling werkt

1. Een node maakt verbinding met de Gateway-WS en vraagt om koppeling.
2. De Gateway slaat een **openstaande aanvraag** op en verzendt `node.pair.requested`.
3. Je keurt de aanvraag goed of wijst deze af (CLI of UI).
4. Bij goedkeuring geeft de Gateway een **nieuw token** uit (tokens worden geroteerd bij herkoppeling).
5. De node maakt opnieuw verbinding met het token en is nu “gekoppeld”.

Openstaande aanvragen verlopen automatisch na **5 minuten**.

## CLI-workflow (headless-vriendelijk)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` toont gekoppelde/verbonden nodes en hun mogelijkheden.

## API-oppervlak (gatewayprotocol)

Events:

- `node.pair.requested` — verzonden wanneer een nieuwe openstaande aanvraag wordt aangemaakt.
- `node.pair.resolved` — verzonden wanneer een aanvraag is goedgekeurd/afgewezen/verlopen.

Methods:

- `node.pair.request` — een openstaande aanvraag aanmaken of hergebruiken.
- `node.pair.list` — openstaande + gekoppelde nodes weergeven.
- `node.pair.approve` — een openstaande aanvraag goedkeuren (geeft token uit).
- `node.pair.reject` — een openstaande aanvraag afwijzen.
- `node.pair.verify` — `{ nodeId, token }` verifiëren.

Notities:

- `node.pair.request` is idempotent per node: herhaalde aanroepen retourneren dezelfde
  openstaande aanvraag.
- Goedkeuring genereert **altijd** een nieuw token; er wordt nooit een token geretourneerd vanuit
  `node.pair.request`.
- Aanvragen kunnen `silent: true` bevatten als hint voor automatische goedkeuringsflows.

## Automatische goedkeuring (macOS-app)

De macOS-app kan optioneel een **stille goedkeuring** proberen wanneer:

- de aanvraag is gemarkeerd als `silent`, en
- de app een SSH-verbinding naar de Gateway-host kan verifiëren met dezelfde gebruiker.

Als stille goedkeuring mislukt, valt deze terug op de normale “Goedkeuren/Afwijzen”-prompt.

## Opslag (lokaal, privé)

De koppelingsstatus wordt opgeslagen onder de Gateway-statusdirectory (standaard `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

Als je `OPENCLAW_STATE_DIR` overschrijft, verhuist de map `nodes/` mee.

Beveiligingsnotities:

- Tokens zijn geheimen; behandel `paired.json` als gevoelig.
- Het roteren van een token vereist hergoedkeuring (of het verwijderen van de nodevermelding).

## Transportgedrag

- Het transport is **stateless**; het slaat geen lidmaatschap op.
- Als de Gateway offline is of koppeling is uitgeschakeld, kunnen nodes niet koppelen.
- Als de Gateway in externe modus staat, vindt koppeling nog steeds plaats tegen de opslag van de externe Gateway.
