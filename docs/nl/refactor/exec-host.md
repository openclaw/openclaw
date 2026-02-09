---
summary: "Refactorplan: exec-hostroutering, node-goedkeuringen en headless runner"
read_when:
  - Ontwerpen van exec-hostroutering of exec-goedkeuringen
  - Implementeren van node runner + UI IPC
  - Toevoegen van exec-hostbeveiligingsmodi en slash-commando’s
title: "Exec-hostrefactor"
---

# Exec-hostrefactorplan

## Doelen

- Voeg `exec.host` + `exec.security` toe om uitvoering te routeren over **sandbox**, **gateway**, en **node**.
- Houd standaardinstellingen **veilig**: geen cross-host-uitvoering tenzij expliciet ingeschakeld.
- Splits uitvoering op in een **headless runner service** met optionele UI (macOS-app) via lokale IPC.
- Bied **per agent** beleid, toegestane lijst, vraagmodus en node-binding.
- Ondersteun **vraagmodi** die werken _met_ of _zonder_ toegestane lijsten.
- Cross-platform: Unix-socket + tokenauthenticatie (macOS/Linux/Windows-pariteit).

## Niet-doelen

- Geen migratie van legacy-toegestane lijsten of ondersteuning voor legacy-schema’s.
- Geen PTY/streaming voor node-exec (alleen geaggregeerde uitvoer).
- Geen nieuwe netwerklaag naast de bestaande Bridge + Gateway.

## Besluiten (vergrendeld)

- **Config-sleutels:** `exec.host` + `exec.security` (per-agent override toegestaan).
- **Elevatie:** behoud `/elevated` als alias voor volledige gateway-toegang.
- **Vraag-standaard:** `on-miss`.
- **Goedkeuringsopslag:** `~/.openclaw/exec-approvals.json` (JSON, geen legacy-migratie).
- **Runner:** headless systeemservice; UI-app host een Unix-socket voor goedkeuringen.
- **Node-identiteit:** gebruik bestaande `nodeId`.
- **Socket-auth:** Unix-socket + token (cross-platform); later splitsen indien nodig.
- **Node-hoststatus:** `~/.openclaw/node.json` (node-id + koppelings-token).
- **macOS exec-host:** voer `system.run` uit binnen de macOS-app; node-hostservice stuurt verzoeken door via lokale IPC.
- **Geen XPC-helper:** blijf bij Unix-socket + token + peer-checks.

## Kernconcepten

### Host

- `sandbox`: Docker-exec (huidig gedrag).
- `gateway`: exec op de Gateway-host.
- `node`: exec op de node runner via Bridge (`system.run`).

### Beveiligingsmodus

- `deny`: altijd blokkeren.
- `allowlist`: alleen overeenkomsten toestaan.
- `full`: alles toestaan (equivalent aan elevated).

### Vraagmodus

- `off`: nooit vragen.
- `on-miss`: alleen vragen wanneer de toegestane lijst niet overeenkomt.
- `always`: elke keer vragen.

Vragen staat **los** van de toegestane lijst; de toegestane lijst kan worden gebruikt met `always` of `on-miss`.

### Beleidsresolutie (per exec)

1. Los `exec.host` op (toolparameter → agent-override → globale standaard).
2. Los `exec.security` en `exec.ask` op (dezelfde prioriteit).
3. Als de host `sandbox` is, ga verder met lokale sandbox-exec.
4. Als de host `gateway` of `node` is, pas beveiligings- en vraagbeleid toe op die host.

## Standaardveiligheid

- Standaard `exec.host = sandbox`.
- Standaard `exec.security = deny` voor `gateway` en `node`.
- Standaard `exec.ask = on-miss` (alleen relevant als beveiliging dit toestaat).
- Als er geen node-binding is ingesteld, **kan de agent elke node targeten**, maar alleen als het beleid dit toestaat.

## Config-oppervlak

### Toolparameters

- `exec.host` (optioneel): `sandbox | gateway | node`.
- `exec.security` (optioneel): `deny | allowlist | full`.
- `exec.ask` (optioneel): `off | on-miss | always`.
- `exec.node` (optioneel): node-id/naam om te gebruiken wanneer `host=node`.

### Config-sleutels (globaal)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (standaard node-binding)

### Config-sleutels (per agent)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = stel `tools.exec.host=gateway`, `tools.exec.security=full` in voor de agentsessie.
- `/elevated off` = herstel eerdere exec-instellingen voor de agentsessie.

## Goedkeuringsopslag (JSON)

Pad: `~/.openclaw/exec-approvals.json`

Doel:

- Lokaal beleid + toegestane lijsten voor de **execution host** (Gateway of node runner).
- Vraag-terugval wanneer geen UI beschikbaar is.
- IPC-credentials voor UI-clients.

Voorgesteld schema (v1):

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

Notities:

- Geen legacy-indelingen voor toegestane lijsten.
- `askFallback` is alleen van toepassing wanneer `ask` vereist is en geen UI bereikbaar is.
- Bestandsrechten: `0600`.

## Runner-service (headless)

### Rol

- Handhaaf `exec.security` + `exec.ask` lokaal.
- Voer systeemcommando’s uit en retourneer uitvoer.
- Zend Bridge-events voor de exec-levenscyclus (optioneel maar aanbevolen).

### Servicelevenscyclus

- Launchd/daemon op macOS; systeemservice op Linux/Windows.
- Goedkeurings-JSON is lokaal op de execution host.
- UI host een lokale Unix-socket; runners verbinden op aanvraag.

## UI-integratie (macOS-app)

### IPC

- Unix-socket op `~/.openclaw/exec-approvals.sock` (0600).
- Token opgeslagen in `exec-approvals.json` (0600).
- Peer-checks: alleen dezelfde UID.
- Challenge/response: nonce + HMAC(token, request-hash) om replay te voorkomen.
- Korte TTL (bijv. 10s) + max payload + rate limit.

### Vraagflow (macOS-app exec-host)

1. Node-service ontvangt `system.run` van de Gateway.
2. Node-service verbindt met de lokale socket en stuurt de prompt/exec-aanvraag.
3. App valideert peer + token + HMAC + TTL en toont indien nodig een dialoog.
4. App voert het commando uit in UI-context en retourneert uitvoer.
5. Node-service retourneert uitvoer naar de Gateway.

Als de UI ontbreekt:

- Pas `askFallback` toe (`deny|allowlist|full`).

### Diagram (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Node-identiteit + binding

- Gebruik bestaande `nodeId` uit Bridge-koppeling.
- Bindingsmodel:
  - `tools.exec.node` beperkt de agent tot een specifieke node.
  - Indien niet ingesteld, kan de agent elke node kiezen (beleid handhaaft nog steeds standaardwaarden).
- Resolutie van node-selectie:
  - `nodeId` exacte match
  - `displayName` (genormaliseerd)
  - `remoteIp`
  - `nodeId`-prefix (>= 6 tekens)

## Eventing

### Wie ziet events

- Systeemevents zijn **per sessie** en worden bij de volgende prompt aan de agent getoond.
- Opgeslagen in de Gateway in-memory-queue (`enqueueSystemEvent`).

### Eventtekst

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + optionele uitvoer-tail
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Transport

Optie A (aanbevolen):

- Runner verzendt Bridge-`event`-frames `exec.started` / `exec.finished`.
- Gateway `handleBridgeEvent` mappt deze naar `enqueueSystemEvent`.

Optie B:

- Gateway `exec`-tool behandelt de levenscyclus direct (alleen synchroon).

## Exec-flows

### Sandbox-host

- Bestaand `exec`-gedrag (Docker of host wanneer niet-gesandboxed).
- PTY ondersteund alleen in niet-sandboxmodus.

### Gateway-host

- Gateway-proces voert uit op zijn eigen machine.
- Handhaaft lokaal `exec-approvals.json` (beveiliging/vraag/toegestane lijst).

### Node-host

- Gateway roept `node.invoke` aan met `system.run`.
- Runner handhaaft lokale goedkeuringen.
- Runner retourneert geaggregeerde stdout/stderr.
- Optionele Bridge-events voor start/finish/weigeren.

## Uitvoercaps

- Beperk gecombineerde stdout+stderr tot **200k**; behoud **tail 20k** voor events.
- Afkappen met een duidelijke suffix (bijv. `"… (truncated)"`).

## Slash-commando’s

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Per agent, per sessie overrides; niet-persistent tenzij opgeslagen via config.
- `/elevated on|off|ask|full` blijft een snelkoppeling voor `host=gateway security=full` (met `full` waarbij goedkeuringen worden overgeslagen).

## Cross-platformverhaal

- De runner-service is het draagbare execution target.
- UI is optioneel; indien ontbrekend, is `askFallback` van toepassing.
- Windows/Linux ondersteunen dezelfde goedkeurings-JSON + socketprotocol.

## Implementatiefasen

### Fase 1: config + exec-routering

- Voeg config-schema toe voor `exec.host`, `exec.security`, `exec.ask`, `exec.node`.
- Werk tool-plumbing bij om `exec.host` te respecteren.
- Voeg `/exec`-slash-commando toe en behoud `/elevated`-alias.

### Fase 2: goedkeuringsopslag + Gateway-handhaving

- Implementeer `exec-approvals.json`-lezer/schrijver.
- Handhaaf toegestane lijst + vraagmodi voor de `gateway`-host.
- Voeg uitvoercaps toe.

### Fase 3: node-runnerhandhaving

- Werk node runner bij om toegestane lijst + vragen te handhaven.
- Voeg Unix-socket prompt-bridge toe naar de macOS-app-UI.
- Koppel `askFallback`.

### Fase 4: events

- Voeg node → Gateway Bridge-events toe voor de exec-levenscyclus.
- Map naar `enqueueSystemEvent` voor agent-prompts.

### Fase 5: UI-polijsten

- Mac-app: editor voor toegestane lijsten, per-agent-switcher, UI voor vraagbeleid.
- Node-bindingbediening (optioneel).

## Testplan

- Unit-tests: matching van toegestane lijsten (glob + niet-hoofdlettergevoelig).
- Unit-tests: prioriteit van beleidsresolutie (toolparameter → agent-override → globaal).
- Integratietests: node runner weiger/toestaan/vraag-flows.
- Bridge-eventtests: node-event → systeemevent-routering.

## Open risico’s

- UI-onbeschikbaarheid: zorg dat `askFallback` wordt gerespecteerd.
- Langlopende commando’s: vertrouw op timeout + uitvoercaps.
- Multi-node-ambiguïteit: fout tenzij node-binding of expliciete node-parameter.

## Gerelateerde documentatie

- [Exec tool](/tools/exec)
- [Exec-goedkeuringen](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated-modus](/tools/elevated)
