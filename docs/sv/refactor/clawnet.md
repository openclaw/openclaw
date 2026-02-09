---
summary: "Clawnet-omstrukturering: förena nätverksprotokoll, roller, autentisering, godkännanden, identitet"
read_when:
  - Planering av ett enhetligt nätverksprotokoll för noder + operatörsklienter
  - Omarbetning av godkännanden, parkoppling, TLS och närvaro över enheter
title: "Clawnet-omstrukturering"
---

# Clawnet-omstrukturering (protokoll + autentiseringsförening)

## Hej

Hej Peter — bra riktning; detta möjliggör enklare UX + starkare säkerhet.

## Syfte

Ett enda, rigoröst dokument för:

- Nuläge: protokoll, flöden, förtroendegränser.
- Smärtpunkter: godkännanden, flerhoppsroutning, UI‑duplicering.
- Föreslaget nytt läge: ett protokoll, avgränsade roller, enhetlig autentisering/parkoppling, TLS‑pinning.
- Identitetsmodell: stabila ID:n + gulliga slugs.
- Migreringsplan, risker, öppna frågor.

## Mål (från diskussion)

- Ett protokoll för alla klienter (mac‑app, CLI, iOS, Android, headless‑nod).
- Varje nätverksdeltagare autentiserad + parkopplad.
- Tydliga roller: noder vs operatörer.
- Centrala godkännanden som routas dit användaren är.
- TLS‑kryptering + valfri pinning för all fjärrtrafik.
- Minimal kodduplicering.
- En enskild maskin ska visas en gång (inga UI/nod‑dubletter).

## Icke‑mål (explicit)

- Ta bort kapabilitetsseparation (minsta privilegium behövs fortfarande).
- Exponera hela gateway‑kontrollplanet utan omfångskontroller.
- Göra autentisering beroende av mänskliga etiketter (slugs förblir icke‑säkerhetskritiska).

---

# Nuläge (as‑is)

## Två protokoll

### 1. Gateway WebSocket (kontrollplan)

- Full API‑yta: konfig, kanaler, modeller, sessioner, agentkörningar, loggar, noder m.m.
- Default bind: loopback. Fjärråtkomst via SSH/Tailscale.
- Autentisering: token/lösenord via `connect`.
- Ingen TLS‑pinning (förlitar sig på loopback/tunnel).
- Kod:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (nodtransport)

- Smal tillåtelselista, nodidentitet + parkoppling.
- JSONL över TCP; valfri TLS + certifikatfingeravtryckspin­ning.
- TLS annonserar fingeravtryck i discovery‑TXT.
- Kod:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Kontrollplansklienter i dag

- CLI → Gateway WS via `callGateway` (`src/gateway/call.ts`).
- macOS‑appens UI → Gateway WS (`GatewayConnection`).
- Web Control UI → Gateway WS.
- ACP → Gateway WS.
- Webbläsarkontroll använder sin egen HTTP‑kontrollserver.

## Noder i dag

- macOS‑app i nodläge ansluter till Gateway bridge (`MacNodeBridgeSession`).
- iOS/Android‑appar ansluter till Gateway bridge.
- Parkoppling + per‑nod‑token lagras på gateway.

## Nuvarande godkännandeflöde (exec)

- Agent använder `system.run` via Gateway.
- Gateway anropar nod via bridge.
- Nodens runtime avgör godkännande.
- UI‑prompt visas av mac‑appen (när nod == mac‑app).
- Noden returnerar `invoke-res` till Gateway.
- Flerhoppsflöde, UI knutet till nodvärden.

## Närvaro + identitet i dag

- Gateway‑närvaroposter från WS‑klienter.
- Nodnärvaroposter från bridge.
- mac‑appen kan visa två poster för samma maskin (UI + nod).
- Nodidentitet lagras i parkopplingslagret; UI‑identitet separat.

---

# Problem / smärtpunkter

- Två protokollstackar att underhålla (WS + Bridge).
- Godkännanden på fjärrnoder: prompten visas på nodvärden, inte där användaren är.
- TLS‑pinning finns bara för bridge; WS beror på SSH/Tailscale.
- Identitetsduplicering: samma maskin visas som flera instanser.
- Otydliga roller: UI + nod + CLI‑kapabiliteter är inte tydligt separerade.

---

# Föreslaget nytt läge (Clawnet)

## Ett protokoll, två roller

Ett enda WS‑protokoll med roll + omfång.

- **Roll: nod** (kapabilitetsvärd)
- **Roll: operatör** (kontrollplan)
- Valfritt **omfång** för operatör:
  - `operator.read` (status + visning)
  - `operator.write` (agentkörning, sändningar)
  - `operator.admin` (konfig, kanaler, modeller)

### Rollbeteenden

**Nod**

- Kan registrera kapabiliteter (`caps`, `commands`, behörigheter).
- Kan ta emot `invoke`‑kommandon (`system.run`, `camera.*`, `canvas.*`, `screen.record`, etc).
- Kan skicka händelser: `voice.transcript`, `agent.request`, `chat.subscribe`.
- Kan inte anropa kontrollplans‑API:er för konfig/modeller/kanaler/sessioner/agent.

**Operatör**

- Full kontrollplans‑API, spärrat av omfång.
- Tar emot alla godkännanden.
- Utför inte OS‑åtgärder direkt; routar till noder.

### Nyckelregel

Rollen är per anslutning, inte per enhet. En enhet kan öppna båda rollerna separat.

---

# Enhetlig autentisering + parkoppling

## Klientidentitet

Varje klient tillhandahåller:

- `deviceId` (stabil, härledd från enhetsnyckel).
- `displayName` (mänskligt namn).
- `role` + `scope` + `caps` + `commands`.

## Parkopplingsflöde (enhetligt)

- Klienten ansluter oautentiserad.
- Gateway skapar en **parkopplingsbegäran** för den `deviceId`.
- Operatör får prompt; godkänner/avslår.
- Gateway utfärdar autentiseringsuppgifter bundna till:
  - enhetens publika nyckel
  - roll(er)
  - omfång
  - kapabiliteter/kommandon
- Klienten sparar token och återansluter autentiserad.

## Enhetsbunden autentisering (undvik replay av bearer‑token)

Föredras: enhetsnyckelpar.

- Enheten genererar nyckelpar en gång.
- `deviceId = fingerprint(publicKey)`.
- Gateway skickar nonce; enheten signerar; gateway verifierar.
- Token utfärdas till en publik nyckel (proof‑of‑possession), inte en sträng.

Alternativ:

- mTLS (klientcertifikat): starkast, mer operativ komplexitet.
- Kortlivade bearer‑tokens endast som temporär fas (rotera + återkalla tidigt).

## Tyst godkännande (SSH‑heuristik)

Definiera det just för att undvika en svag länk. Föredrar ett:

- **Endast lokalt**: auto‑parkoppla när klient ansluter via loopback/Unix‑socket.
- **Utmaning via SSH**: gateway utfärdar nonce; klient bevisar SSH genom att hämta den.
- **Fysisk närvaroperiod**: efter ett lokalt godkännande i gateway‑värdens UI, tillåt auto‑parkoppling under ett kort fönster (t.ex. 10 minuter).

Logga och registrera alltid auto‑godkännanden.

---

# TLS överallt (dev + prod)

## Återanvänd befintlig bridge‑TLS

Använd nuvarande TLS‑runtime + fingeravtryckspin­ning:

- `src/infra/bridge/server/tls.ts`
- verifieringslogik för fingeravtryck i `src/node-host/bridge-client.ts`

## Tillämpa på WS

- WS‑servern stöder TLS med samma cert/nyckel + fingeravtryck.
- WS‑klienter kan pina fingeravtryck (valfritt).
- Discovery annonserar TLS + fingeravtryck för alla endpoints.
  - Discovery är endast lokaliseringshintar; aldrig ett förtroendeankare.

## Varför

- Minska beroendet av SSH/Tailscale för konfidentialitet.
- Göra fjärranslutningar från mobiler säkra som standard.

---

# Omarbetning av godkännanden (centraliserad)

## Nuvarande

Godkännande sker på nod värd (Mac app nod runtime). Fråga visas där noden körs.

## Föreslaget

Godkännande är **gateway‑värdbaserat**, UI levereras till operatörsklienter.

### Nytt flöde

1. Gateway tar emot `system.run`‑avsikt (agent).
2. Gateway skapar godkännandepost: `approval.requested`.
3. Operatörs‑UI:n visar prompt.
4. Godkännandebeslut skickas till gateway: `approval.resolve`.
5. Gateway anropar nodkommando om godkänt.
6. Noden exekverar, returnerar `invoke-res`.

### Godkännandesemantik (härdning)

- Sänds till alla operatörer; endast det aktiva UI:t visar modal (andra får en toast).
- Första beslut vinner; gateway avvisar efterföljande som redan avgjorda.
- Standardtimeout: neka efter N sekunder (t.ex. 60 s), logga orsak.
- Beslut kräver `operator.approvals`‑omfång.

## Fördelar

- Prompten visas där användaren är (mac/telefon).
- Konsekventa godkännanden för fjärrnoder.
- Nod‑runtime förblir headless; inget UI‑beroende.

---

# Exempel på rolltydlighet

## iPhone‑app

- **Nodroll** för: mikrofon, kamera, röstchatt, plats, push‑to‑talk.
- Valfri **operator.read** för status och chattvy.
- Valfri **operator.write/admin** endast när uttryckligen aktiverad.

## macOS‑app

- Operatörsroll som standard (kontroll‑UI).
- Nodroll när ”Mac‑nod” är aktiverad (system.run, skärm, kamera).
- Samma deviceId för båda anslutningarna → sammanslagen UI‑post.

## CLI

- Alltid operatörsroll.
- Omfång härleds av underkommando:
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - godkännanden + parkoppling → `operator.approvals` / `operator.pairing`

---

# Identitet + slugs

## Stabilt ID

Krävs för författare; aldrig ändras.
Föredraget:

- Fingeravtryck av nyckelpar (hash av publik nyckel).

## Gullig slug (hummer‑tema)

Endast mänsklig etikett.

- Exempel: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Lagrade i gateway‑registret, redigerbara.
- Krockhantering: `-2`, `-3`.

## UI‑gruppering

Samma `deviceId` över roller → en enda ”Instans”-rad:

- Badge: `operator`, `node`.
- Visar kapabiliteter + senast sedd.

---

# Migreringsstrategi

## Fas 0: Dokumentera + samordna

- Publicera detta dokument.
- Inventera alla protokollanrop + godkännandeflöden.

## Fas 1: Lägg till roller/omfång i WS

- Utöka `connect`‑parametrar med `role`, `scope`, `deviceId`.
- Lägg till tillåtelseliste‑spärrar för nodrollen.

## Fas 2: Bridge‑kompatibilitet

- Behåll bridge igång.
- Lägg till WS‑nodstöd parallellt.
- Spärra funktioner bakom konfig‑flagga.

## Fas 3: Centrala godkännanden

- Lägg till händelser för godkännandebegäran + lösning i WS.
- Uppdatera mac‑appens UI för att prompta + svara.
- Nod‑runtime slutar visa UI‑prompter.

## Fas 4: TLS‑förening

- Lägg till TLS‑konfig för WS med bridge‑TLS‑runtime.
- Lägg till pinning i klienter.

## Fas 5: Avveckla bridge

- Migrera iOS/Android/mac‑nod till WS.
- Behåll bridge som fallback; ta bort när stabilt.

## Fas 6: Enhetsbunden autentisering

- Kräv nyckelbaserad identitet för alla icke‑lokala anslutningar.
- Lägg till UI för återkallning + rotation.

---

# Säkerhetsnoteringar

- Roll/tillåtelselista verkställs vid gateway‑gränsen.
- Ingen klient får ”fullt” API utan operatörsomfång.
- Parkoppling krävs för _alla_ anslutningar.
- TLS + pinning minskar MITM‑risk för mobiler.
- Tyst SSH‑godkännande är en bekvämlighet; loggas + kan återkallas.
- Discovery är aldrig ett förtroendeankare.
- Kapabilitetsanspråk verifieras mot serverns tillåtelselistor per plattform/typ.

# Streaming + stora payloads (nodmedia)

WS‑kontrollplanet är bra för små meddelanden, men noder gör också:

- kameraklipp
- skärminspelningar
- ljudströmmar

Alternativ:

1. WS‑binära ramar + chunking + backpressure‑regler.
2. Separat streaming‑endpoint (fortfarande TLS + autentisering).
3. Behåll bridge längre för mediakrävande kommandon, migrera sist.

Välj ett före implementation för att undvika avdrift.

# Kapabilitets‑ och kommandopolicy

- Nodrapporterade kapabiliteter/kommandon behandlas som **anspråk**.
- Gateway verkställer per‑plattform‑tillåtelselistor.
- Varje nytt kommando kräver operatörsgodkännande eller explicit ändring av tillåtelselista.
- Granska ändringar med tidsstämplar.

# Revision + hastighetsbegränsning

- Logga: parkopplingsbegäranden, godkännanden/avslag, tokenutfärdande/rotation/återkallning.
- Hastighetsbegränsa parkopplingsspam och godkännande‑prompter.

# Protokollhygien

- Explicit protokollversion + felkoder.
- Återanslutningsregler + heartbeat‑policy.
- Närvaro‑TTL och semantik för ”senast sedd”.

---

# Öppna frågor

1. En enhet som kör båda rollerna: token‑modell
   - Rekommenderar separata tokens per roll (nod vs operatör).
   - Samma deviceId; olika omfång; tydligare återkallning.

2. Granularitet för operatörsomfång
   - read/write/admin + godkännanden + parkoppling (minsta gångbara).
   - Överväg per‑funktionsomfång senare.

3. UX för tokenrotation + återkallning
   - Auto‑rotera vid rolländring.
   - UI för att återkalla per deviceId + roll.

4. Discovery
   - Utöka nuvarande Bonjour‑TXT med WS‑TLS‑fingeravtryck + rollhintar.
   - Behandla endast som lokaliseringshintar.

5. Godkännande över nätverk
   - Sänd till alla operatörsklienter; aktivt UI visar modal.
   - Första svar vinner; gateway säkerställer atomicitet.

---

# Sammanfattning (TL;DR)

- I dag: WS‑kontrollplan + Bridge‑nodtransport.
- Smärta: godkännanden + duplicering + två stackar.
- Förslag: ett WS‑protokoll med explicita roller + omfång, enhetlig parkoppling + TLS‑pinning, gateway‑värdbaserade godkännanden, stabila enhets‑ID:n + gulliga slugs.
- Resultat: enklare UX, starkare säkerhet, mindre duplicering, bättre mobilroutning.
