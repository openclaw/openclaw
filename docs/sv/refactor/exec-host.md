---
summary: "Refaktorplan: routning av exec-värd, nodgodkännanden och headless runner"
read_when:
  - Utformar routning av exec-värd eller exec-godkännanden
  - Implementerar nodrunner + UI IPC
  - Lägger till säkerhetslägen för exec-värd och slash-kommandon
title: "Refaktorering av exec-värd"
---

# Plan för refaktorering av exec-värd

## Mål

- Lägg till `exec.host` + `exec.security` för att routa exekvering över **sandbox**, **gateway** och **node**.
- Behåll standardinställningar **säkra**: ingen korsvärdsexekvering om det inte uttryckligen aktiveras.
- Dela upp exekvering i en **headless runner-tjänst** med valfri UI (macOS-app) via lokal IPC.
- Tillhandahåll **per-agent**-policy, tillåtelselista, frågeläge och nodbindning.
- Stöd **frågelägen** som fungerar _med_ eller _utan_ tillåtelselistor.
- Plattformsoberoende: Unix-socket + tokenautentisering (macOS/Linux/Windows-paritet).

## Icke-mål

- Ingen migrering av äldre tillåtelselistor eller stöd för äldre scheman.
- Ingen PTY/streaming för nod-exec (endast aggregerad utdata).
- Inget nytt nätverkslager utöver befintlig Bridge + Gateway.

## Beslut (låsta)

- **Konfignycklar:** `exec.host` + `exec.security` (per-agent-överskrivning tillåten).
- **Förhöjning:** behåll `/elevated` som alias för full gateway-åtkomst.
- **Standard för fråga:** `on-miss`.
- **Godkännandelagring:** `~/.openclaw/exec-approvals.json` (JSON, ingen äldre migrering).
- **Runner:** headless systemtjänst; UI-appen hostar en Unix-socket för godkännanden.
- **Nodidentitet:** använd befintlig `nodeId`.
- **Socket-autentisering:** Unix-socket + token (plattformsoberoende); dela upp senare vid behov.
- **Nodvärdsstatus:** `~/.openclaw/node.json` (nod-id + parningstoken).
- **macOS exec-värd:** kör `system.run` inuti macOS-appen; nodvärdstjänsten vidarebefordrar förfrågningar över lokal IPC.
- **Ingen XPC-hjälpare:** håll fast vid Unix-socket + token + peer-kontroller.

## Nyckelbegrepp

### Värd

- `sandbox`: Docker-exec (nuvarande beteende).
- `gateway`: exec på gateway-värden.
- `node`: exec på nodrunner via Bridge (`system.run`).

### Säkerhetsläge

- `deny`: blockera alltid.
- `allowlist`: tillåt endast matchningar.
- `full`: tillåt allt (motsvarar förhöjt läge).

### Frågeläge

- `off`: fråga aldrig.
- `on-miss`: fråga endast när tillåtelselistan inte matchar.
- `always`: fråga varje gång.

Fråga är **oberoende** av tillåtelselista; tillåtelselistan kan användas med `always` eller `on-miss`.

### Policylösning (per exec)

1. Lös `exec.host` (verktygsparameter → agentöverskrivning → global standard).
2. Lös `exec.security` och `exec.ask` (samma företräde).
3. Om värden är `sandbox`, fortsätt med lokal sandbox-exec.
4. Om värden är `gateway` eller `node`, tillämpa säkerhets- och frågepolicy på den värden.

## Standardsäkerhet

- Standard `exec.host = sandbox`.
- Standard `exec.security = deny` för `gateway` och `node`.
- Standard `exec.ask = on-miss` (endast relevant om säkerheten tillåter).
- Om ingen nodbindning är satt kan **agenten rikta mot vilken nod som helst**, men endast om policyn tillåter det.

## Konfigurationsyta

### Verktygsparametrar

- `exec.host` (valfri): `sandbox | gateway | node`.
- `exec.security` (valfri): `deny | allowlist | full`.
- `exec.ask` (valfri): `off | on-miss | always`.
- `exec.node` (valfri): nod-id/-namn att använda när `host=node`.

### Konfignycklar (globalt)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (standard nodbindning)

### Konfignycklar (per agent)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = sätt `tools.exec.host=gateway`, `tools.exec.security=full` för agentsessionen.
- `/elevated off` = återställ tidigare exec-inställningar för agentsessionen.

## Godkännandelagring (JSON)

Sökväg: `~/.openclaw/exec-approvals.json`

Syfte:

- Lokal policy + tillåtelselistor för **exekveringsvärden** (gateway eller nodrunner).
- Fråge-fallback när inget UI är tillgängligt.
- IPC-uppgifter för UI-klienter.

Föreslaget schema (v1):

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

Noteringar:

- Inga äldre format för tillåtelselistor.
- `askFallback` gäller endast när `ask` krävs och inget UI kan nås.
- Filbehörigheter: `0600`.

## Runner-tjänst (headless)

### Roll

- Tillämpa `exec.security` + `exec.ask` lokalt.
- Exekvera systemkommandon och returnera utdata.
- Skicka Bridge-händelser för exec-livscykeln (valfritt men rekommenderat).

### Tjänstens livscykel

- Launchd/daemon på macOS; systemtjänst på Linux/Windows.
- Godkännanden JSON är lokal för exekveringsvärden.
- UI hostar en lokal Unix-socket; runners ansluter vid behov.

## UI-integration (macOS-app)

### IPC

- Unix-socket på `~/.openclaw/exec-approvals.sock` (0600).
- Token lagrad i `exec-approvals.json` (0600).
- Peer-kontroller: endast samma UID.
- Challenge/response: nonce + HMAC(token, request-hash) för att förhindra replay.
- Kort TTL (t.ex. 10 s) + max nyttolast + hastighetsbegränsning.

### Frågeflöde (macOS-appens exec-värd)

1. Nods tjänst tar emot `system.run` från gateway.
2. Nods tjänst ansluter till den lokala socketen och skickar prompt/exec-förfrågan.
3. Appen validerar peer + token + HMAC + TTL och visar dialog vid behov.
4. Appen exekverar kommandot i UI-kontext och returnerar utdata.
5. Nods tjänst returnerar utdata till gateway.

Om UI saknas:

- Tillämpa `askFallback` (`deny|allowlist|full`).

### Diagram (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Nodidentitet + bindning

- Använd befintlig `nodeId` från Bridge-parning.
- Bindningsmodell:
  - `tools.exec.node` begränsar agenten till en specifik nod.
  - Om ej satt kan agenten välja vilken nod som helst (policyn upprätthåller fortfarande standarder).
- Upplösning av nodval:
  - `nodeId` exakt match
  - `displayName` (normaliserad)
  - `remoteIp`
  - `nodeId` prefix (≥ 6 tecken)

## Händelser

### Vem ser händelser

- Systemhändelser är **per session** och visas för agenten vid nästa prompt.
- Lagrade i gatewayens minneskö (`enqueueSystemEvent`).

### Händelsetext

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + valfri utdata-tail
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Transport

Alternativ A (rekommenderat):

- Runner skickar Bridge-ramar `event` `exec.started` / `exec.finished`.
- Gateway `handleBridgeEvent` mappar dessa till `enqueueSystemEvent`.

Alternativ B:

- Gateway-verktyget `exec` hanterar livscykeln direkt (endast synkront).

## Exec-flöden

### Sandbox-värd

- Befintligt beteende `exec` (Docker eller värd när osandboxad).
- PTY stöds endast i icke-sandboxläge.

### Gateway-värd

- Gateway-processen exekverar på sin egen maskin.
- Tillämpa lokal `exec-approvals.json` (säkerhet/fråga/tillåtelselista).

### Nodvärd

- Gateway anropar `node.invoke` med `system.run`.
- Runner tillämpar lokala godkännanden.
- Runner returnerar aggregerad stdout/stderr.
- Valfria Bridge-händelser för start/slut/nekad.

## Utdata-tak

- Begränsa kombinerad stdout+stderr till **200k**; behåll **tail 20k** för händelser.
- Trunkera med ett tydligt suffix (t.ex., `"… (förkortad)"`).

## Slash-kommandon

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Per-agent, per-session-överskrivningar; icke-beständiga om de inte sparas via konfig.
- `/elevated on|off|ask|full` förblir en genväg för `host=gateway security=full` (med `full` som hoppar över godkännanden).

## Plattformsoberoende berättelse

- Runner-tjänsten är det portabla exekveringsmålet.
- UI är valfritt; om det saknas tillämpas `askFallback`.
- Windows/Linux stöder samma godkännanden JSON + socket-protokoll.

## Implementeringsfaser

### Fas 1: konfig + exec-routning

- Lägg till konfigschema för `exec.host`, `exec.security`, `exec.ask`, `exec.node`.
- Uppdatera verktygsplumbing för att respektera `exec.host`.
- Lägg till slash-kommandot `/exec` och behåll aliaset `/elevated`.

### Fas 2: godkännandelagring + gateway-tillämpning

- Implementera läsare/skrivare för `exec-approvals.json`.
- Tillämpa tillåtelselista + frågelägen för värden `gateway`.
- Lägg till utdata-tak.

### Fas 3: nodrunner-tillämpning

- Uppdatera nodrunner för att tillämpa tillåtelselista + fråga.
- Lägg till Unix-socket prompt-bridge till macOS-appens UI.
- Koppla `askFallback`.

### Fas 4: händelser

- Lägg till Bridge-händelser nod → gateway för exec-livscykeln.
- Mappa till `enqueueSystemEvent` för agentprompter.

### Fas 5: UI-polish

- Mac-app: tillåtelselisteeditor, per-agent-växlare, UI för frågepolicy.
- Kontroller för nodbindning (valfritt).

## Testplan

- Enhetstester: matchning av tillåtelselista (glob + skiftlägesokänslig).
- Enhetstester: policylösningens företräde (verktygsparameter → agentöverskrivning → global).
- Integrationstester: nodrunner nekad/tillåten/fråga-flöden.
- Tester för Bridge-händelser: nodhändelse → systemhändelseroutning.

## Öppna risker

- UI-otillgänglighet: säkerställ att `askFallback` respekteras.
- Långvariga kommandon: förlita dig på timeout + utdata-tak.
- Flernoder-ambiguïtet: fel om inte nodbindning eller explicit nodparameter anges.

## Relaterad dokumentation

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated mode](/tools/elevated)
