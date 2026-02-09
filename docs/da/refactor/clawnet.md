---
summary: "Clawnet-refaktor: saml netværksprotokol, roller, auth, godkendelser og identitet"
read_when:
  - Planlægning af en samlet netværksprotokol for noder + operatørklienter
  - Omstrukturering af godkendelser, parring, TLS og presence på tværs af enheder
title: "Clawnet-refaktor"
---

# Clawnet-refaktor (protokol + auth-samling)

## Hej

Hej Peter — rigtig god retning; det åbner for enklere UX + stærkere sikkerhed.

## Formål

Ét samlet, stringent dokument for:

- Nuværende tilstand: protokoller, flows, tillidsgrænser.
- Smertpunkter: godkendelser, multi-hop-routing, UI-duklering.
- Foreslået ny tilstand: én protokol, afgrænsede roller, samlet auth/parring, TLS-pinning.
- Identitetsmodel: stabile ID’er + søde slugs.
- Migreringsplan, risici, åbne spørgsmål.

## Mål (fra diskussion)

- Én protokol for alle klienter (mac-app, CLI, iOS, Android, headless node).
- Alle netværksdeltagere autentificeret + parret.
- Klar rolleopdeling: noder vs. operatører.
- Centrale godkendelser routet derhen, hvor brugeren er.
- TLS-kryptering + valgfri pinning for al fjerntrafik.
- Minimal kodeduplikering.
- Én maskine skal kun fremstå én gang (ingen UI/node-dublet).

## Ikke-mål (eksplicit)

- Fjerne kapabilitetsadskillelse (mindste privilegium er stadig nødvendigt).
- Eksponere hele gatewayens control plane uden scope-tjek.
- Gøre auth afhængig af menneskelige labels (slugs forbliver ikke-sikkerhedsrelevante).

---

# Nuværende tilstand (as-is)

## To protokoller

### 1. Gateway WebSocket (control plane)

- Fuldt API-areal: konfiguration, kanaler, modeller, sessioner, agentkørsler, logs, noder osv.
- Default bind: loopback. Fjernadgang via SSH/Tailscale.
- Auth: token/adgangskode via `connect`.
- Ingen TLS-pinning (afhænger af loopback/tunnel).
- Kode:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (node-transport)

- Smal tilladelsesliste-overflade, node-identitet + parring.
- JSONL over TCP; valgfri TLS + certifikat-fingerprint-pinning.
- TLS annoncerer fingerprint i discovery TXT.
- Kode:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Control plane-klienter i dag

- CLI → Gateway WS via `callGateway` (`src/gateway/call.ts`).
- macOS-app UI → Gateway WS (`GatewayConnection`).
- Web Control UI → Gateway WS.
- ACP → Gateway WS.
- Browserkontrol bruger sin egen HTTP-control-server.

## Noder i dag

- macOS-app i node-tilstand forbinder til Gateway bridge (`MacNodeBridgeSession`).
- iOS/Android-apps forbinder til Gateway bridge.
- Parring + per-node-token lagres på gatewayen.

## Nuværende godkendelsesflow (exec)

- Agent bruger `system.run` via Gateway.
- Gateway kalder node over bridge.
- Node-runtime beslutter godkendelse.
- UI-prompt vises af mac-appen (når node == mac-app).
- Node returnerer `invoke-res` til Gateway.
- Multi-hop, UI bundet til node-vært.

## Presence + identitet i dag

- Gateway presence-poster fra WS-klienter.
- Node presence-poster fra bridge.
- mac-appen kan vise to poster for samme maskine (UI + node).
- Node-identitet lagret i pairing store; UI-identitet separat.

---

# Problemer / smertpunkter

- To protokolstakke at vedligeholde (WS + Bridge).
- Godkendelser på fjerne noder: prompt vises på node-værten, ikke der hvor brugeren er.
- TLS-pinning findes kun for bridge; WS afhænger af SSH/Tailscale.
- Identitetsduplikering: samme maskine vises som flere instanser.
- Tvetydige roller: UI + node + CLI-kapabiliteter er ikke klart adskilt.

---

# Foreslået ny tilstand (Clawnet)

## Én protokol, to roller

Én WS-protokol med rolle + scope.

- **Rolle: node** (kapabilitetsvært)
- **Rolle: operator** (control plane)
- Valgfrit **scope** for operator:
  - `operator.read` (status + visning)
  - `operator.write` (agentkørsel, afsendelser)
  - `operator.admin` (konfiguration, kanaler, modeller)

### Rolleadfærd

**Node**

- Kan registrere kapabiliteter (`caps`, `commands`, tilladelser).
- Kan modtage `invoke`-kommandoer (`system.run`, `camera.*`, `canvas.*`, `screen.record`, osv.).
- Kan sende events: `voice.transcript`, `agent.request`, `chat.subscribe`.
- Kan ikke kalde control plane-API’er for konfiguration/modeller/kanaler/sessioner/agent.

**Operator**

- Fuldt control plane-API, afgrænset af scope.
- Modtager alle godkendelser.
- Udfører ikke direkte OS-handlinger; router til noder.

### Nøgleregel

Rolle er per-connect, ikke pr. enhed. En enhed kan åbne begge roller separat.

---

# Samlet autentificering + parring

## Klientidentitet

Hver klient leverer:

- `deviceId` (stabil, afledt af enhedsnøgle).
- `displayName` (menneskeligt navn).
- `role` + `scope` + `caps` + `commands`.

## Parringsflow (samlet)

- Klient forbinder uautentificeret.
- Gateway opretter en **parringsanmodning** for den `deviceId`.
- Operator modtager prompt; godkender/afviser.
- Gateway udsteder legitimationsoplysninger bundet til:
  - enhedens offentlige nøgle
  - rolle(r)
  - scope(s)
  - kapabiliteter/kommandoer
- Klienten gemmer token og genforbinder autentificeret.

## Enhedsbundet auth (undgå replay af bearer tokens)

Foretrukket: enhedsnøglepar.

- Enhed genererer nøglepar én gang.
- `deviceId = fingerprint(publicKey)`.
- Gateway sender nonce; enhed signerer; gateway verificerer.
- Tokens udstedes til en offentlig nøgle (proof-of-possession), ikke en streng.

Alternativer:

- mTLS (klientcertifikater): stærkest, mere ops-kompleksitet.
- Kortlivede bearer tokens kun som midlertidig fase (roter + tilbagekald tidligt).

## Stille godkendelse (SSH-heuristik)

Definér det præcist for at undgå et svagt link. Foretræk et:

- **Kun lokalt**: auto-parring når klient forbinder via loopback/Unix-socket.
- **Challenge via SSH**: gateway udsteder nonce; klient beviser SSH ved at hente den.
- **Vindue for fysisk tilstedeværelse**: efter lokal godkendelse i gateway-værtens UI, tillad auto-parring i et kort vindue (fx 10 minutter).

Log og registrér altid auto-godkendelser.

---

# TLS overalt (dev + prod)

## Genbrug eksisterende bridge-TLS

Brug nuværende TLS-runtime + fingerprint-pinning:

- `src/infra/bridge/server/tls.ts`
- fingerprint-verifikationslogik i `src/node-host/bridge-client.ts`

## Anvend på WS

- WS-server understøtter TLS med samme cert/nøgle + fingerprint.
- WS-klienter kan pinne fingerprint (valgfrit).
- Discovery annoncerer TLS + fingerprint for alle endpoints.
  - Discovery er kun locator-hints; aldrig et trust anchor.

## Hvorfor

- Reducér afhængighed af SSH/Tailscale for fortrolighed.
- Gør fjerne mobile forbindelser sikre som standard.

---

# Redesign af godkendelser (centraliseret)

## Nuværende

Godkendelse sker på node vært (mac app node runtime). Spørg vises, hvor indholdselementet kører.

## Foreslået

Godkendelse er **gateway-hostet**, UI leveres til operatørklienter.

### Nyt flow

1. Gateway modtager `system.run`-intent (agent).
2. Gateway opretter godkendelsespost: `approval.requested`.
3. Operatør-UI’er viser prompt.
4. Godkendelsesbeslutning sendes til gateway: `approval.resolve`.
5. Gateway kalder node-kommando, hvis godkendt.
6. Node udfører og returnerer `invoke-res`.

### Godkendelsessemantik (hærdning)

- Broadcast til alle operatører; kun den aktive UI viser en modal (andre får en toast).
- Første afgørelse vinder; gateway afviser efterfølgende afgørelser som allerede afgjort.
- Standard-timeout: afvis efter N sekunder (fx 60s), log årsag.
- Afgørelse kræver `operator.approvals`-scope.

## Fordele

- Prompt vises der, hvor brugeren er (mac/telefon).
- Konsistente godkendelser for fjerne noder.
- Node-runtime forbliver headless; ingen UI-afhængighed.

---

# Rolleeksempler

## iPhone-app

- **Node-rolle** for: mikrofon, kamera, stemmechat, lokation, push-to-talk.
- Valgfri **operator.read** for status og chat-visning.
- Valgfri **operator.write/admin** kun når eksplicit aktiveret.

## macOS-app

- Operator-rolle som standard (control UI).
- Node-rolle når “Mac node” er aktiveret (system.run, skærm, kamera).
- Samme deviceId for begge forbindelser → samlet UI-post.

## CLI

- Operator-rolle altid.
- Scope afledt af underkommando:
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - godkendelser + parring → `operator.approvals` / `operator.pairing`

---

# Identitet + slugs

## Stabilt ID

Kræves til auth; ændrer sig aldrig.
Foretrukket:

- Nøglepar-fingerprint (offentlig nøgle-hash).

## Sød slug (hummer-tema)

Kun menneskeligt label.

- Eksempel: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Lagres i gateway-registeret, redigerbar.
- Kollisionhåndtering: `-2`, `-3`.

## UI-gruppering

Samme `deviceId` på tværs af roller → én “Instans”-række:

- Badge: `operator`, `node`.
- Viser kapabiliteter + sidst set.

---

# Migreringsstrategi

## Fase 0: Dokumentér + afstem

- Udgiv dette dokument.
- Opgør alle protokolkald + godkendelsesflows.

## Fase 1: Tilføj roller/scopes til WS

- Udvid `connect`-parametre med `role`, `scope`, `deviceId`.
- Tilføj allowlist-gating for node-rollen.

## Fase 2: Bridge-kompatibilitet

- Behold bridge kørende.
- Tilføj WS-node-understøttelse parallelt.
- Afgræns features bag konfigurationsflag.

## Fase 3: Centrale godkendelser

- Tilføj godkendelsesforespørgsel + resolve-events i WS.
- Opdater mac-app UI til at prompte + svare.
- Node-runtime stopper med at vise UI-prompter.

## Fase 4: TLS-samling

- Tilføj TLS-konfiguration for WS ved brug af bridge-TLS-runtime.
- Tilføj pinning til klienter.

## Fase 5: Udfas bridge

- Migrér iOS/Android/mac node til WS.
- Behold bridge som fallback; fjern når stabil.

## Fase 6: Enhedsbundet auth

- Kræv nøglebaseret identitet for alle ikke-lokale forbindelser.
- Tilføj UI til tilbagekaldelse + rotation.

---

# Sikkerhedsnoter

- Rolle/allowlist håndhæves ved gateway-grænsen.
- Ingen klient får “fuldt” API uden operator-scope.
- Parring kræves for _alle_ forbindelser.
- TLS + pinning reducerer MITM-risiko for mobile.
- SSH-stille godkendelse er en bekvemmelighed; stadig registreret + kan tilbagekaldes.
- Discovery er aldrig et trust anchor.
- Kapabilitetsclaims verificeres mod server-allowlists efter platform/type.

# Streaming + store payloads (node-medier)

WS control plane er fin til små beskeder, men noder laver også:

- kameraklip
- skærmoptagelser
- audiostreams

Muligheder:

1. WS binære frames + chunking + backpressure-regler.
2. Separat streaming-endpoint (stadig TLS + auth).
3. Behold bridge længere for medietunge kommandoer, migrér sidst.

Vælg én før implementering for at undgå drift.

# Kapabilitets- + kommandopolitik

- Node-rapporterede caps/kommandoer behandles som **claims**.
- Gateway håndhæver per-platform allowlists.
- Enhver ny kommando kræver operator-godkendelse eller eksplicit allowlist-ændring.
- Auditér ændringer med tidsstempler.

# Audit + rate limiting

- Log: parringsanmodninger, godkendelser/afvisninger, token-udstedelse/rotation/tilbagekaldelse.
- Rate-limit parringsspam og godkendelsesprompter.

# Protokolhygiejne

- Eksplicit protokolversion + fejlkoder.
- Reconnect-regler + heartbeat-politik.
- Presence-TTL og last-seen-semantik.

---

# Åbne spørgsmål

1. Én enhed der kører begge roller: token-model
   - Anbefal separate tokens pr. rolle (node vs. operator).
   - Samme deviceId; forskellige scopes; tydeligere tilbagekaldelse.

2. Granularitet af operator-scopes
   - read/write/admin + godkendelser + parring (minimum).
   - Overvej per-feature-scopes senere.

3. Token-rotation + tilbagekaldelses-UX
   - Auto-rotér ved rolleændring.
   - UI til tilbagekaldelse pr. deviceId + rolle.

4. Discovery
   - Udvid nuværende Bonjour TXT til at inkludere WS TLS-fingerprint + rollehints.
   - Behandl kun som locator-hints.

5. Godkendelse på tværs af netværk
   - Broadcast til alle operatørklienter; aktiv UI viser modal.
   - Første svar vinder; gateway håndhæver atomicitet.

---

# Opsummering (TL;DR)

- I dag: WS control plane + Bridge node-transport.
- Smerter: godkendelser + duplikering + to stacks.
- Forslag: én WS-protokol med eksplicitte roller + scopes, samlet parring + TLS-pinning, gateway-hostede godkendelser, stabile device ID’er + søde slugs.
- Resultat: enklere UX, stærkere sikkerhed, mindre duplikering, bedre mobil routing.
