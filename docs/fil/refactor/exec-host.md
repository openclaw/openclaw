---
summary: "Plano ng refactor: routing ng exec host, mga pag-apruba ng node, at headless runner"
read_when:
  - Nagdidisenyo ng routing ng exec host o mga pag-apruba ng exec
  - Nag-iimplement ng node runner + UI IPC
  - Nagdadagdag ng mga security mode ng exec host at slash commands
title: "Refactor ng Exec Host"
---

# Plano ng refactor ng exec host

## Mga layunin

- Idagdag ang `exec.host` + `exec.security` para i-route ang execution sa **sandbox**, **gateway**, at **node**.
- Panatilihing **ligtas** ang mga default: walang cross-host execution maliban kung hayagang pinagana.
- Hatiin ang execution sa isang **headless runner service** na may opsyonal na UI (macOS app) sa pamamagitan ng local IPC.
- Magbigay ng **per-agent** na policy, allowlist, ask mode, at node binding.
- Suportahan ang mga **ask mode** na gumagana _may_ o _walang_ allowlists.
- Cross-platform: Unix socket + token auth (macOS/Linux/Windows parity).

## Mga hindi layunin

- Walang legacy allowlist migration o suporta sa legacy schema.
- Walang PTY/streaming para sa node exec (pinagsamang output lang).
- Walang bagong network layer lampas sa kasalukuyang Bridge + Gateway.

## Mga desisyon (naka-lock)

- **Mga config key:** `exec.host` + `exec.security` (pinapayagan ang per-agent override).
- **Elevation:** panatilihin ang `/elevated` bilang alias para sa full access ng gateway.
- **Ask default:** `on-miss`.
- **Imbakan ng mga pag-apruba:** `~/.openclaw/exec-approvals.json` (JSON, walang legacy migration).
- **Runner:** headless system service; ang UI app ang nagho-host ng Unix socket para sa mga pag-apruba.
- **Node identity:** gamitin ang umiiral na `nodeId`.
- **Socket auth:** Unix socket + token (cross-platform); paghihiwalayin sa hinaharap kung kailangan.
- **Node host state:** `~/.openclaw/node.json` (node id + pairing token).
- **macOS exec host:** patakbuhin ang `system.run` sa loob ng macOS app; ang node host service ang nagfo-forward ng mga request sa local IPC.
- **Walang XPC helper:** manatili sa Unix socket + token + peer checks.

## Mga pangunahing konsepto

### Host

- `sandbox`: Docker exec (kasalukuyang behavior).
- `gateway`: exec sa gateway host.
- `node`: exec sa node runner sa pamamagitan ng Bridge (`system.run`).

### Security mode

- `deny`: palaging i-block.
- `allowlist`: payagan lang ang mga tumutugma.
- `full`: payagan ang lahat (katumbas ng elevated).

### Ask mode

- `off`: huwag kailanman magtanong.
- `on-miss`: magtanong lang kapag hindi tumugma ang allowlist.
- `always`: magtanong sa bawat pagkakataon.

Ang Ask ay **independyente** sa allowlist; maaaring gamitin ang allowlist kasama ng `always` o `on-miss`.

### Resolusyon ng policy (bawat exec)

1. I-resolve ang `exec.host` (tool param → agent override → global default).
2. I-resolve ang `exec.security` at `exec.ask` (parehong precedence).
3. Kung ang host ay `sandbox`, magpatuloy sa local sandbox exec.
4. Kung ang host ay `gateway` o `node`, ilapat ang security + ask policy sa host na iyon.

## Default na kaligtasan

- Default `exec.host = sandbox`.
- Default `exec.security = deny` para sa `gateway` at `node`.
- Default `exec.ask = on-miss` (may kaugnayan lang kung pinapayagan ng security).
- Kung walang nakatakdang node binding, **maaaring mag-target ang agent ng kahit anong node**, ngunit kung pinapayagan lang ng policy.

## Config surface

### Mga parameter ng tool

- `exec.host` (opsyonal): `sandbox | gateway | node`.
- `exec.security` (opsyonal): `deny | allowlist | full`.
- `exec.ask` (opsyonal): `off | on-miss | always`.
- `exec.node` (opsyonal): node id/pangalan na gagamitin kapag `host=node`.

### Mga config key (global)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (default na node binding)

### Mga config key (per agent)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = itakda ang `tools.exec.host=gateway`, `tools.exec.security=full` para sa agent session.
- `/elevated off` = ibalik ang naunang exec settings para sa agent session.

## Imbakan ng mga pag-apruba (JSON)

Path: `~/.openclaw/exec-approvals.json`

Layunin:

- Lokal na policy + allowlists para sa **execution host** (gateway o node runner).
- Ask fallback kapag walang available na UI.
- Mga kredensyal ng IPC para sa mga UI client.

Iminungkahing schema (v1):

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

Mga tala:

- Walang legacy allowlist formats.
- Nalalapat lang ang `askFallback` kapag kailangan ang `ask` at walang maabot na UI.
- Mga pahintulot ng file: `0600`.

## Runner service (headless)

### Papel

- Ipatupad ang `exec.security` + `exec.ask` nang lokal.
- I-execute ang mga system command at ibalik ang output.
- Maglabas ng mga Bridge event para sa lifecycle ng exec (opsyonal ngunit inirerekomenda).

### Lifecycle ng serbisyo

- Launchd/daemon sa macOS; system service sa Linux/Windows.
- Lokal sa execution host ang Approvals JSON.
- Ang UI ang nagho-host ng lokal na Unix socket; kumokonekta ang mga runner kapag kinakailangan.

## Integrasyon ng UI (macOS app)

### IPC

- Unix socket sa `~/.openclaw/exec-approvals.sock` (0600).
- Token na naka-store sa `exec-approvals.json` (0600).
- Mga peer check: parehong UID lang.
- Challenge/response: nonce + HMAC(token, request-hash) para pigilan ang replay.
- Maikling TTL (hal., 10s) + max payload + rate limit.

### Ask flow (macOS app exec host)

1. Tinatanggap ng node service ang `system.run` mula sa gateway.
2. Kumokonekta ang node service sa lokal na socket at ipinapadala ang prompt/exec request.
3. Vine-validate ng app ang peer + token + HMAC + TTL, saka ipinapakita ang dialog kung kailangan.
4. Ipinapatupad ng app ang command sa UI context at ibinabalik ang output.
5. Ibinabalik ng node service ang output sa gateway.

Kung walang UI:

- Ilapat ang `askFallback` (`deny|allowlist|full`).

### Diagram (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Node identity + binding

- Gamitin ang umiiral na `nodeId` mula sa Bridge pairing.
- Binding model:
  - Nililimitahan ng `tools.exec.node` ang agent sa isang partikular na node.
  - Kapag hindi nakatakda, maaaring pumili ang agent ng kahit anong node (ipatutupad pa rin ng policy ang mga default).
- Resolusyon ng pagpili ng node:
  - `nodeId` eksaktong tugma
  - `displayName` (normalized)
  - `remoteIp`
  - `nodeId` prefix (>= 6 na karakter)

## Eventing

### Sino ang nakakakita ng mga event

- Ang mga system event ay **per session** at ipinapakita sa agent sa susunod na prompt.
- Ini-store sa in-memory queue ng gateway (`enqueueSystemEvent`).

### Teksto ng event

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + opsyonal na output tail
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Transport

Opsyon A (inirerekomenda):

- Nagpapadala ang runner ng Bridge `event` frames `exec.started` / `exec.finished`.
- Imina-map ng gateway `handleBridgeEvent` ang mga ito sa `enqueueSystemEvent`.

Opsyon B:

- Hinahawakan ng gateway `exec` tool ang lifecycle nang direkta (synchronous lang).

## Mga exec flow

### Sandbox host

- Umiiral na behavior ng `exec` (Docker o host kapag unsandboxed).
- Sinusuportahan lang ang PTY sa non-sandbox mode.

### Gateway host

- Ang proseso ng Gateway ay nag-e-execute sa sarili nitong makina.
- Ipinapatupad ang lokal na `exec-approvals.json` (security/ask/allowlist).

### Node host

- Tinatawag ng gateway ang `node.invoke` gamit ang `system.run`.
- Ipinapatupad ng runner ang lokal na mga pag-apruba.
- Ibinabalik ng runner ang pinagsamang stdout/stderr.
- Opsyonal na Bridge events para sa start/finish/deny.

## Mga limitasyon ng output

- I-cap ang pinagsamang stdout+stderr sa **200k**; panatilihin ang **tail na 20k** para sa mga event.
- 30. I-truncate gamit ang malinaw na suffix (hal., `"… 31. (truncated)"`).

## Mga slash command

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Mga per-agent, per-session override; hindi persistent maliban kung i-save sa pamamagitan ng config.
- Ang `/elevated on|off|ask|full` ay nananatiling shortcut para sa `host=gateway security=full` (na may `full` na nilalaktawan ang mga pag-apruba).

## Cross-platform na kuwento

- Ang runner service ang portable na execution target.
- Opsyonal ang UI; kung wala, ilalapat ang `askFallback`.
- Sinusuportahan ng Windows/Linux ang parehong approvals JSON + socket protocol.

## Mga yugto ng implementasyon

### Phase 1: config + exec routing

- Idagdag ang config schema para sa `exec.host`, `exec.security`, `exec.ask`, `exec.node`.
- I-update ang tool plumbing para igalang ang `exec.host`.
- Idagdag ang `/exec` slash command at panatilihin ang `/elevated` alias.

### Phase 2: approvals store + gateway enforcement

- I-implement ang reader/writer ng `exec-approvals.json`.
- Ipatupad ang allowlist + ask modes para sa `gateway` host.
- Idagdag ang mga output cap.

### Phase 3: node runner enforcement

- I-update ang node runner para ipatupad ang allowlist + ask.
- Idagdag ang Unix socket prompt bridge sa UI ng macOS app.
- Ikabit ang `askFallback`.

### Phase 4: mga event

- Idagdag ang node → gateway Bridge events para sa lifecycle ng exec.
- I-map sa `enqueueSystemEvent` para sa mga prompt ng agent.

### Phase 5: UI polish

- Mac app: allowlist editor, per-agent switcher, ask policy UI.
- Mga kontrol sa node binding (opsyonal).

## Plano sa testing

- Unit tests: pagtutugma ng allowlist (glob + case-insensitive).
- Unit tests: precedence ng resolusyon ng policy (tool param → agent override → global).
- Integration tests: mga flow ng deny/allow/ask ng node runner.
- Mga Bridge event test: node event → system event routing.

## Mga bukas na panganib

- Hindi available ang UI: tiyaking iginagalang ang `askFallback`.
- Mga long-running command: umasa sa timeout + mga output cap.
- Multi-node ambiguity: error maliban kung may node binding o tahasang node param.

## Kaugnay na docs

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated mode](/tools/elevated)
