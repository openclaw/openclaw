---
summary: "Clawnet-refactor: netwerkprotocol, rollen, authenticatie, goedkeuringen en identiteit verenigen"
read_when:
  - Een uniform netwerkprotocol plannen voor nodes + operatorclients
  - Goedkeuringen, pairing, TLS en presence over apparaten heen herwerken
title: "Clawnet-refactor"
---

# Clawnet-refactor (protocol + auth-unificatie)

## Hi

Hoi Peter — geweldige richting; dit ontsluit een eenvoudigere UX + sterkere beveiliging.

## Doel

Eén enkel, strikt document voor:

- Huidige staat: protocollen, flows, vertrouwensgrenzen.
- Pijnpunten: goedkeuringen, multi-hop routing, UI-duplicatie.
- Voorgestelde nieuwe staat: één protocol, gescopeerde rollen, uniforme auth/pairing, TLS-pinning.
- Identiteitsmodel: stabiele ID’s + leuke slugs.
- Migratieplan, risico’s, open vragen.

## Doelen (uit de discussie)

- Eén protocol voor alle clients (mac-app, CLI, iOS, Android, headless node).
- Elke netwerkdeelnemer geauthenticeerd + gepaird.
- Duidelijke rollen: nodes vs operators.
- Centrale goedkeuringen gerouteerd naar waar de gebruiker is.
- TLS-encryptie + optionele pinning voor al het remote verkeer.
- Minimale code-duplicatie.
- Eén machine verschijnt één keer (geen dubbele UI/node-vermelding).

## Niet-doelen (expliciet)

- Capaciteitsscheiding verwijderen (least-privilege blijft nodig).
- Volledige Gateway-control-plane blootstellen zonder scope-checks.
- Auth laten afhangen van menselijke labels (slugs blijven niet-beveiligingskritisch).

---

# Huidige staat (as-is)

## Twee protocollen

### 1. Gateway WebSocket (control plane)

- Volledig API-oppervlak: config, kanalen, modellen, sessies, agent-runs, logs, nodes, enz.
- Standaardbinding: loopback. Externe toegang via SSH/Tailscale.
- Auth: token/wachtwoord via `connect`.
- Geen TLS-pinning (vertrouwt op loopback/tunnel).
- Code:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (node-transport)

- Smal toegestaan oppervlak, node-identiteit + pairing.
- JSONL over TCP; optionele TLS + certificaatvingerafdruk-pinning.
- TLS adverteert vingerafdruk in discovery TXT.
- Code:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Control-plane-clients vandaag

- CLI → Gateway WS via `callGateway` (`src/gateway/call.ts`).
- macOS-app-UI → Gateway WS (`GatewayConnection`).
- Web Control UI → Gateway WS.
- ACP → Gateway WS.
- Browserbediening gebruikt een eigen HTTP-control-server.

## Nodes vandaag

- macOS-app in node-modus verbindt met Gateway-bridge (`MacNodeBridgeSession`).
- iOS/Android-apps verbinden met Gateway-bridge.
- Pairing + per-node-token opgeslagen op de gateway.

## Huidige goedkeuringsflow (exec)

- Agent gebruikt `system.run` via Gateway.
- Gateway roept node aan via bridge.
- Node-runtime beslist over goedkeuring.
- UI-prompt getoond door mac-app (wanneer node == mac-app).
- Node retourneert `invoke-res` aan Gateway.
- Multi-hop, UI gekoppeld aan node-host.

## Presence + identiteit vandaag

- Gateway-presence-entries van WS-clients.
- Node-presence-entries van bridge.
- mac-app kan twee vermeldingen tonen voor dezelfde machine (UI + node).
- Node-identiteit opgeslagen in pairing store; UI-identiteit apart.

---

# Problemen / pijnpunten

- Twee protocolstacks om te onderhouden (WS + Bridge).
- Goedkeuringen op externe nodes: prompt verschijnt op node-host, niet waar de gebruiker is.
- TLS-pinning bestaat alleen voor bridge; WS vertrouwt op SSH/Tailscale.
- Identiteitsduplicatie: dezelfde machine verschijnt als meerdere instanties.
- Ambigue rollen: UI + node + CLI-capabilities niet duidelijk gescheiden.

---

# Voorgestelde nieuwe staat (Clawnet)

## Eén protocol, twee rollen

Één WS-protocol met rol + scope.

- **Rol: node** (capability-host)
- **Rol: operator** (control plane)
- Optionele **scope** voor operator:
  - `operator.read` (status + bekijken)
  - `operator.write` (agent-run, verzenden)
  - `operator.admin` (config, kanalen, modellen)

### Rolgedrag

**Node**

- Kan capabilities registreren (`caps`, `commands`, rechten).
- Kan `invoke`-opdrachten ontvangen (`system.run`, `camera.*`, `canvas.*`, `screen.record`, enz.).
- Kan events verzenden: `voice.transcript`, `agent.request`, `chat.subscribe`.
- Kan geen config-/modellen-/kanalen-/sessies-/agent-control-plane-API’s aanroepen.

**Operator**

- Volledige control-plane-API, afgeschermd door scope.
- Ontvangt alle goedkeuringen.
- Voert geen OS-acties direct uit; routeert naar nodes.

### Kernregel

Rol is per verbinding, niet per apparaat. Een apparaat kan beide rollen openen, afzonderlijk.

---

# Uniforme authenticatie + pairing

## Clientidentiteit

Elke client levert:

- `deviceId` (stabiel, afgeleid van apparaatsleutel).
- `displayName` (menselijke naam).
- `role` + `scope` + `caps` + `commands`.

## Pairingflow (uniform)

- Client verbindt ongeauthenticeerd.
- Gateway maakt een **pairingverzoek** voor die `deviceId`.
- Operator ontvangt prompt; keurt goed/weigert.
- Gateway geeft credentials uit gebonden aan:
  - apparaat-publieke sleutel
  - rol(len)
  - scope(s)
  - capabilities/opdrachten
- Client bewaart token, herverbindt geauthenticeerd.

## Apparaatgebonden auth (bearer token replay vermijden)

Voorkeur: apparaat-keypairs.

- Apparaat genereert eenmalig keypair.
- `deviceId = fingerprint(publicKey)`.
- Gateway stuurt nonce; apparaat tekent; gateway verifieert.
- Tokens worden uitgegeven aan een publieke sleutel (proof-of-possession), niet aan een string.

Alternatieven:

- mTLS (clientcertificaten): sterkst, meer operationele complexiteit.
- Kortlevende bearer tokens alleen als tijdelijke fase (vroeg roteren + intrekken).

## Stille goedkeuring (SSH-heuristiek)

Definieer dit precies om een zwakke schakel te vermijden. Kies bij voorkeur één:

- **Alleen lokaal**: auto-pair wanneer client via loopback/Unix-socket verbindt.
- **Uitdaging via SSH**: gateway geeft nonce uit; client bewijst SSH door die op te halen.
- **Fysieke-aanwezigheidsvenster**: na een lokale goedkeuring op de Gateway-host-UI, auto-pair toestaan voor een kort venster (bijv. 10 minuten).

Altijd loggen + auto-goedkeuringen vastleggen.

---

# TLS overal (dev + prod)

## Bestaande bridge-TLS hergebruiken

Gebruik huidige TLS-runtime + vingerafdruk-pinning:

- `src/infra/bridge/server/tls.ts`
- vingerafdruk-verificatielogica in `src/node-host/bridge-client.ts`

## Toepassen op WS

- WS-server ondersteunt TLS met hetzelfde cert/sleutel + vingerafdruk.
- WS-clients kunnen vingerafdruk pinnen (optioneel).
- Discovery adverteert TLS + vingerafdruk voor alle endpoints.
  - Discovery is alleen locator-hints; nooit een trust anchor.

## Waarom

- Minder afhankelijkheid van SSH/Tailscale voor vertrouwelijkheid.
- Externe mobiele verbindingen standaard veilig maken.

---

# Herontwerp van goedkeuringen (gecentraliseerd)

## Huidig

Goedkeuring gebeurt op de node-host (mac-app node-runtime). Prompt verschijnt waar de node draait.

## Voorgesteld

Goedkeuring is **gateway-gehost**, UI geleverd aan operatorclients.

### Nieuwe flow

1. Gateway ontvangt `system.run`-intent (agent).
2. Gateway maakt goedkeuringsrecord: `approval.requested`.
3. Operator-UI(s) tonen prompt.
4. Goedkeuringsbeslissing wordt naar gateway gestuurd: `approval.resolve`.
5. Gateway roept node-opdracht aan indien goedgekeurd.
6. Node voert uit, retourneert `invoke-res`.

### Goedkeuringssemantiek (verharding)

- Uitzenden naar alle operators; alleen de actieve UI toont een modal (anderen krijgen een toast).
- Eerste beslissing wint; gateway weigert latere resolves als al afgehandeld.
- Standaard time-out: weigeren na N seconden (bijv. 60s), reden loggen.
- Afhandeling vereist `operator.approvals`-scope.

## Voordelen

- Prompt verschijnt waar de gebruiker is (mac/telefoon).
- Consistente goedkeuringen voor externe nodes.
- Node-runtime blijft headless; geen UI-afhankelijkheid.

---

# Voorbeelden van rolhelderheid

## iPhone-app

- **Node-rol** voor: microfoon, camera, spraakchat, locatie, push-to-talk.
- Optionele **operator.read** voor status en chatweergave.
- Optionele **operator.write/admin** alleen wanneer expliciet ingeschakeld.

## macOS-app

- Operator-rol standaard (control-UI).
- Node-rol wanneer “Mac node” is ingeschakeld (system.run, scherm, camera).
- Zelfde deviceId voor beide verbindingen → samengevoegde UI-vermelding.

## CLI

- Altijd operator-rol.
- Scope afgeleid per subcommand:
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - goedkeuringen + pairing → `operator.approvals` / `operator.pairing`

---

# Identiteit + slugs

## Stabiele ID

Vereist voor auth; verandert nooit.
Voorkeur:

- Keypair-vingerafdruk (hash van publieke sleutel).

## Leuke slug (kreeft-thema)

Alleen menselijk label.

- Voorbeeld: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Opgeslagen in gateway-register, bewerkbaar.
- Botsingsafhandeling: `-2`, `-3`.

## UI-groepering

Zelfde `deviceId` over rollen → één “Instance”-rij:

- Badge: `operator`, `node`.
- Toont capabilities + laatst gezien.

---

# Migratiestrategie

## Fase 0: Documenteren + afstemmen

- Dit document publiceren.
- Alle protocolaanroepen + goedkeuringsflows inventariseren.

## Fase 1: Rollen/scopes toevoegen aan WS

- `connect`-params uitbreiden met `role`, `scope`, `deviceId`.
- Allowlist-afscherming toevoegen voor node-rol.

## Fase 2: Bridge-compatibiliteit

- Bridge actief houden.
- WS-node-ondersteuning parallel toevoegen.
- Features achter config-flag plaatsen.

## Fase 3: Centrale goedkeuringen

- Goedkeuringsaanvraag + resolve-events toevoegen in WS.
- mac-app-UI bijwerken om te prompten + reageren.
- Node-runtime stopt met UI-prompten.

## Fase 4: TLS-unificatie

- TLS-config toevoegen voor WS met bridge-TLS-runtime.
- Pinning toevoegen aan clients.

## Fase 5: Bridge uitfaseren

- iOS/Android/mac-node migreren naar WS.
- Bridge als fallback behouden; verwijderen zodra stabiel.

## Fase 6: Apparaatgebonden auth

- Sleutelgebaseerde identiteit vereisen voor alle niet-lokale verbindingen.
- UI toevoegen voor intrekken + roteren.

---

# Beveiligingsnotities

- Rol/allowlist afgedwongen aan de gateway-grens.
- Geen client krijgt de “volledige” API zonder operator-scope.
- Pairing vereist voor _alle_ verbindingen.
- TLS + pinning verminderen MITM-risico voor mobiel.
- SSH-stille goedkeuring is gemak; blijft geregistreerd + intrekbaar.
- Discovery is nooit een trust anchor.
- Capability-claims worden door de server geverifieerd tegen allowlists per platform/type.

# Streaming + grote payloads (node-media)

WS-control-plane is prima voor kleine berichten, maar nodes doen ook:

- cameraclips
- schermopnames
- audiostreams

Opties:

1. WS-binaire frames + chunking + backpressure-regels.
2. Aparte streaming-endpoint (nog steeds TLS + auth).
3. Bridge langer behouden voor mediagezware opdrachten, als laatste migreren.

Kies één vóór implementatie om drift te vermijden.

# Capability- + commandbeleid

- Door nodes gerapporteerde caps/commands worden behandeld als **claims**.
- Gateway handhaaft allowlists per platform.
- Elke nieuwe opdracht vereist operatorgoedkeuring of expliciete allowlist-wijziging.
- Wijzigingen auditen met timestamps.

# Audit + rate limiting

- Loggen: pairingverzoeken, goedkeuringen/weigeringen, token-uitgifte/rotatie/intrekking.
- Pairing-spam en goedkeuringsprompts rate-limiten.

# Protocolhygiëne

- Expliciete protocolversie + foutcodes.
- Reconnect-regels + heartbeat-beleid.
- Presence-TTL en last-seen-semantiek.

---

# Open vragen

1. Eén apparaat met beide rollen: tokenmodel
   - Aanbevolen: aparte tokens per rol (node vs operator).
   - Zelfde deviceId; verschillende scopes; duidelijkere intrekking.

2. Granulariteit van operator-scope
   - read/write/admin + goedkeuringen + pairing (minimaal levensvatbaar).
   - Overweeg later scopes per feature.

3. UX voor tokenrotatie + intrekking
   - Auto-roteren bij rolwijziging.
   - UI om per deviceId + rol in te trekken.

4. Discovery
   - Huidige Bonjour TXT uitbreiden met WS-TLS-vingerafdruk + rolhints.
   - Alleen als locator-hints behandelen.

5. Cross-network goedkeuring
   - Uitzenden naar alle operatorclients; actieve UI toont modal.
   - Eerste reactie wint; gateway handhaaft atomiciteit.

---

# Samenvatting (TL;DR)

- Vandaag: WS-control-plane + Bridge node-transport.
- Pijn: goedkeuringen + duplicatie + twee stacks.
- Voorstel: één WS-protocol met expliciete rollen + scopes, uniforme pairing + TLS-pinning, gateway-gehoste goedkeuringen, stabiele device-ID’s + leuke slugs.
- Resultaat: eenvoudigere UX, sterkere beveiliging, minder duplicatie, betere mobiele routing.
