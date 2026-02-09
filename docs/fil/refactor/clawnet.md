---
summary: "Refactor ng Clawnet: pag-isahin ang network protocol, mga role, auth, approvals, at identity"
read_when:
  - Pagpaplano ng isang pinag-isang network protocol para sa mga node + operator client
  - Pagre-rework ng approvals, pairing, TLS, at presence sa iba’t ibang device
title: "Clawnet Refactor"
---

# Clawnet refactor (pag-iisa ng protocol + auth)

## Hi

Hi Peter — mahusay na direksyon; nagbubukas ito ng mas simpleng UX + mas matibay na seguridad.

## Layunin

Isang iisa at mahigpit na dokumento para sa:

- Kasalukuyang estado: mga protocol, daloy, trust boundaries.
- Mga pain point: approvals, multi‑hop routing, pagdodoble ng UI.
- Iminungkahing bagong estado: isang protocol, scoped roles, pinag-isang auth/pairing, TLS pinning.
- Modelo ng identity: stable IDs + cute slugs.
- Migration plan, mga panganib, at mga bukas na tanong.

## Mga layunin (mula sa talakayan)

- Isang protocol para sa lahat ng client (mac app, CLI, iOS, Android, headless node).
- Lahat ng kalahok sa network ay authenticated + paired.
- Malinaw na mga role: nodes vs operators.
- Sentralisadong approvals na niruruta kung nasaan ang user.
- TLS encryption + opsyonal na pinning para sa lahat ng remote traffic.
- Minimal na pagdodoble ng code.
- Isang machine ay dapat lumabas nang isang beses lang (walang UI/node duplicate entry).

## Mga hindi layunin (explicit)

- Alisin ang paghihiwalay ng capability (kailangan pa rin ang least‑privilege).
- I-expose ang buong gateway control plane nang walang scope checks.
- Gawing dependent ang auth sa mga human label (ang slugs ay non‑security pa rin).

---

# Kasalukuyang estado (as‑is)

## Dalawang protocol

### 1. Gateway WebSocket (control plane)

- Buong API surface: config, channels, models, sessions, agent runs, logs, nodes, atbp.
- 21. Default na bind: loopback. Remote access via SSH/Tailscale.
- Auth: token/password sa pamamagitan ng `connect`.
- Walang TLS pinning (umaasa sa loopback/tunnel).
- Code:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (node transport)

- Makitid na allowlist surface, node identity + pairing.
- JSONL sa ibabaw ng TCP; opsyonal na TLS + cert fingerprint pinning.
- Ina-advertise ng TLS ang fingerprint sa discovery TXT.
- Code:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Mga control plane client ngayon

- CLI → Gateway WS sa pamamagitan ng `callGateway` (`src/gateway/call.ts`).
- macOS app UI → Gateway WS (`GatewayConnection`).
- Web Control UI → Gateway WS.
- ACP → Gateway WS.
- Gumagamit ang browser control ng sarili nitong HTTP control server.

## Mga node ngayon

- macOS app sa node mode ay kumokonekta sa Gateway bridge (`MacNodeBridgeSession`).
- iOS/Android apps ay kumokonekta sa Gateway bridge.
- Pairing + per‑node token ay naka-store sa gateway.

## Kasalukuyang approval flow (exec)

- Gumagamit ang agent ng `system.run` sa pamamagitan ng Gateway.
- Ini-invoke ng Gateway ang node sa bridge.
- Nagdedesisyon ang node runtime sa approval.
- Ipinapakita ang UI prompt ng mac app (kapag ang node == mac app).
- Ibinabalik ng node ang `invoke-res` sa Gateway.
- Multi‑hop, at nakatali ang UI sa host ng node.

## Presence + identity ngayon

- Gateway presence entries mula sa WS clients.
- Node presence entries mula sa bridge.
- Maaaring magpakita ang mac app ng dalawang entry para sa parehong machine (UI + node).
- Naka-store ang node identity sa pairing store; hiwalay ang UI identity.

---

# Mga problema / pain points

- Dalawang protocol stack na kailangang i-maintain (WS + Bridge).
- Approvals sa remote nodes: lumalabas ang prompt sa host ng node, hindi kung nasaan ang user.
- May TLS pinning lang ang bridge; umaasa ang WS sa SSH/Tailscale.
- Pagdodoble ng identity: ang parehong machine ay lumalabas bilang maraming instance.
- Malabong mga role: hindi malinaw ang paghihiwalay ng kakayahan ng UI + node + CLI.

---

# Iminungkahing bagong estado (Clawnet)

## Isang protocol, dalawang role

Isang WS protocol na may role + scope.

- **Role: node** (host ng capability)
- **Role: operator** (control plane)
- Opsyonal na **scope** para sa operator:
  - `operator.read` (status + viewing)
  - `operator.write` (agent run, sends)
  - `operator.admin` (config, channels, models)

### Mga behavior ng role

**Node**

- Maaaring mag-register ng capabilities (`caps`, `commands`, permissions).
- Maaaring tumanggap ng mga command na `invoke` (`system.run`, `camera.*`, `canvas.*`, `screen.record`, atbp).
- Maaaring magpadala ng mga event: `voice.transcript`, `agent.request`, `chat.subscribe`.
- Hindi maaaring tumawag sa config/models/channels/sessions/agent control plane APIs.

**Operator**

- Buong control plane API, na naka-gate ayon sa scope.
- Tumatanggap ng lahat ng approvals.
- Hindi direktang nag-e-execute ng OS actions; niruruta sa mga node.

### Pangunahing tuntunin

23. Ang role ay per-connection, hindi per device. A device may open both roles, separately.

---

# Pinag-isang authentication + pairing

## Client identity

Bawat client ay nagbibigay ng:

- `deviceId` (stable, hango sa device key).
- `displayName` (pangalan para sa tao).
- `role` + `scope` + `caps` + `commands`.

## Pairing flow (pinag-isa)

- Kumokonekta ang client nang hindi authenticated.
- Gumagawa ang Gateway ng **pairing request** para sa `deviceId` na iyon.
- Tumatanggap ng prompt ang operator; inaaprubahan/tinatanggihan.
- Nag-iisyu ang Gateway ng credentials na naka-bind sa:
  - device public key
  - role(s)
  - scope(s)
  - capabilities/commands
- Ipinipersist ng client ang token, at muling kumokonekta nang authenticated.

## Device‑bound auth (iwasan ang bearer token replay)

Mas gusto: device keypairs.

- Gumagawa ang device ng keypair nang isang beses.
- `deviceId = fingerprint(publicKey)`.
- Nagpapadala ang Gateway ng nonce; pinipirmahan ng device; vine-verify ng gateway.
- Ang mga token ay iniisyu sa isang public key (proof‑of‑possession), hindi sa isang string.

Mga alternatibo:

- mTLS (client certs): pinakamatibay, mas maraming ops complexity.
- Short‑lived bearer tokens bilang pansamantalang yugto lamang (i-rotate + i-revoke nang maaga).

## Silent approval (SSH heuristic)

Define it precisely to avoid a weak link. 26. Pumili ng isa:

- **Local‑only**: auto‑pair kapag kumonekta ang client sa loopback/Unix socket.
- **Challenge via SSH**: nag-iisyu ang gateway ng nonce; pinapatunayan ng client ang SSH sa pamamagitan ng pag-fetch nito.
- **Physical presence window**: pagkatapos ng isang lokal na approval sa gateway host UI, payagan ang auto‑pair sa maikling window (hal. 10 minuto).

Palaging i-log + i-record ang mga auto‑approval.

---

# TLS kahit saan (dev + prod)

## Gamitin muli ang umiiral na bridge TLS

Gamitin ang kasalukuyang TLS runtime + fingerprint pinning:

- `src/infra/bridge/server/tls.ts`
- fingerprint verification logic sa `src/node-host/bridge-client.ts`

## Ilapat sa WS

- Sinusuportahan ng WS server ang TLS gamit ang parehong cert/key + fingerprint.
- Maaaring mag-pin ng fingerprint ang mga WS client (opsyonal).
- Ina-advertise ng discovery ang TLS + fingerprint para sa lahat ng endpoint.
  - Ang discovery ay locator hints lamang; hindi kailanman trust anchor.

## Bakit

- Bawasan ang pag-asa sa SSH/Tailscale para sa confidentiality.
- Gawing ligtas by default ang remote mobile connections.

---

# Redesign ng approvals (sentralisado)

## Kasalukuyan

27. Ang approval ay nangyayari sa node host (mac app node runtime). Prompt appears where node runs.

## Iminungkahi

Ang approval ay **hosted ng gateway**, at ang UI ay inihahatid sa mga operator client.

### Bagong daloy

1. Tumatanggap ang Gateway ng intent na `system.run` (agent).
2. Gumagawa ang Gateway ng approval record: `approval.requested`.
3. Ipinapakita ng operator UI(s) ang prompt.
4. Ipinapadala ang desisyon sa approval sa gateway: `approval.resolve`.
5. Ini-invoke ng Gateway ang node command kung naaprubahan.
6. Nag-e-execute ang node, ibinabalik ang `invoke-res`.

### Approval semantics (hardening)

- I-broadcast sa lahat ng operator; ang active UI lang ang nagpapakita ng modal (ang iba ay toast).
- Ang unang resolusyon ang panalo; tinatanggihan ng gateway ang mga susunod bilang settled na.
- Default timeout: deny pagkatapos ng N segundo (hal. 60s), i-log ang dahilan.
- Nangangailangan ang resolusyon ng `operator.approvals` scope.

## Mga benepisyo

- Lumalabas ang prompt kung nasaan ang user (mac/phone).
- Konsistent na approvals para sa remote nodes.
- Mananatiling headless ang node runtime; walang UI dependency.

---

# Mga halimbawa ng linaw ng role

## iPhone app

- **Node role** para sa: mic, camera, voice chat, location, push‑to‑talk.
- Opsyonal na **operator.read** para sa status at chat view.
- Opsyonal na **operator.write/admin** lamang kapag tahasang pinagana.

## macOS app

- Operator role bilang default (control UI).
- Node role kapag naka-enable ang “Mac node” (system.run, screen, camera).
- Parehong deviceId para sa parehong connection → pinagsamang UI entry.

## CLI

- Operator role palagi.
- Ang scope ay hango sa subcommand:
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - approvals + pairing → `operator.approvals` / `operator.pairing`

---

# Identity + slugs

## Stable ID

29. Kinakailangan para sa auth; hindi kailanman nagbabago.
    Mas mainam:

- Keypair fingerprint (public key hash).

## Cute slug (lobster‑themed)

Label lang para sa tao.

- Halimbawa: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Naka-store sa gateway registry, editable.
- Paghawak sa collision: `-2`, `-3`.

## UI grouping

Parehong `deviceId` sa iba’t ibang role → isang “Instance” row:

- Badge: `operator`, `node`.
- Ipinapakita ang capabilities + last seen.

---

# Diskarte sa migration

## Phase 0: I-dokumento + i-align

- I-publish ang dokumentong ito.
- I-inventory ang lahat ng protocol calls + approval flows.

## Phase 1: Magdagdag ng roles/scopes sa WS

- I-extend ang `connect` params gamit ang `role`, `scope`, `deviceId`.
- Magdagdag ng allowlist gating para sa node role.

## Phase 2: Bridge compatibility

- Panatilihing tumatakbo ang bridge.
- Magdagdag ng WS node support nang sabay.
- I-gate ang mga feature sa likod ng config flag.

## Phase 3: Sentral na approvals

- Magdagdag ng approval request + resolve events sa WS.
- I-update ang mac app UI para mag-prompt + tumugon.
- Itigil ng node runtime ang pagpa-prompt ng UI.

## Phase 4: TLS unification

- Magdagdag ng TLS config para sa WS gamit ang bridge TLS runtime.
- Magdagdag ng pinning sa mga client.

## Phase 5: I-deprecate ang bridge

- I-migrate ang iOS/Android/mac node sa WS.
- Panatilihin ang bridge bilang fallback; alisin kapag stable na.

## Phase 6: Device‑bound auth

- I-require ang key‑based identity para sa lahat ng non‑local connection.
- Magdagdag ng UI para sa revocation + rotation.

---

# Mga tala sa seguridad

- Ang role/allowlist ay ipinapatupad sa gateway boundary.
- Walang client ang nakakakuha ng “full” API nang walang operator scope.
- Kinakailangan ang pairing para sa _lahat_ ng connection.
- Ang TLS + pinning ay nagpapababa ng MITM risk para sa mobile.
- Ang SSH silent approval ay convenience; naka-record pa rin + maaaring i-revoke.
- Ang discovery ay hindi kailanman trust anchor.
- Ang mga claim ng capability ay vine-verify laban sa server allowlists ayon sa platform/type.

# Streaming + malalaking payload (node media)

Ayos ang WS control plane para sa maliliit na mensahe, pero ginagawa rin ng mga node ang:

- camera clips
- screen recordings
- audio streams

Mga opsyon:

1. WS binary frames + chunking + backpressure rules.
2. Hiwalay na streaming endpoint (TLS + auth pa rin).
3. Panatilihin ang bridge nang mas matagal para sa media‑heavy commands, huling i-migrate.

Pumili ng isa bago ang implementasyon upang maiwasan ang drift.

# Policy ng capability + command

- Ang mga cap/command na ini-report ng node ay itinuturing na **claims**.
- Ipinapatupad ng Gateway ang per‑platform allowlists.
- Anumang bagong command ay nangangailangan ng operator approval o tahasang pagbabago sa allowlist.
- I-audit ang mga pagbabago na may timestamps.

# Audit + rate limiting

- I-log: pairing requests, approvals/denials, token issuance/rotation/revocation.
- I-rate‑limit ang pairing spam at approval prompts.

# Protocol hygiene

- Tahasang protocol version + error codes.
- Mga patakaran sa reconnect + heartbeat.
- Presence TTL at last‑seen semantics.

---

# Mga bukas na tanong

1. Isang device na nagpapatakbo ng parehong role: token model
   - Irekomenda ang hiwalay na token bawat role (node vs operator).
   - Parehong deviceId; magkaibang scope; mas malinaw ang revocation.

2. Granularity ng operator scope
   - read/write/admin + approvals + pairing (minimum viable).
   - Isaalang-alang ang per‑feature scopes sa hinaharap.

3. UX ng token rotation + revocation
   - Auto‑rotate kapag nagbago ang role.
   - UI para mag-revoke ayon sa deviceId + role.

4. Discovery
   - I-extend ang kasalukuyang Bonjour TXT upang isama ang WS TLS fingerprint + role hints.
   - Ituring lamang bilang locator hints.

5. Cross‑network approval
   - I-broadcast sa lahat ng operator client; ang active UI ang nagpapakita ng modal.
   - Ang unang sagot ang panalo; ipinapatupad ng gateway ang atomicity.

---

# Buod (TL;DR)

- Ngayon: WS control plane + Bridge node transport.
- Sakit: approvals + pagdodoble + dalawang stack.
- Panukala: isang WS protocol na may malinaw na roles + scopes, pinag-isang pairing + TLS pinning, gateway‑hosted approvals, stable device IDs + cute slugs.
- Resulta: mas simpleng UX, mas matibay na seguridad, mas kaunting pagdodoble, mas maayos na mobile routing.
