---
summary: "Gebruik van de Exec-tool, stdin-modi en TTY-ondersteuning"
read_when:
  - Bij het gebruiken of aanpassen van de exec-tool
  - Bij het debuggen van stdin- of TTY-gedrag
title: "Exec-tool"
---

# Exec-tool

Voer shellopdrachten uit in de werkruimte. Ondersteunt uitvoering op de voorgrond en achtergrond via `process`.
Als `process` niet is toegestaan, wordt `exec` synchroon uitgevoerd en worden `yieldMs`/`background` genegeerd.
Achtergrondsessies zijn per agent afgebakend; `process` ziet alleen sessies van dezelfde agent.

## Parameters

- `command` (vereist)
- `workdir` (standaard naar cwd)
- `env` (key/value-overschrijvingen)
- `yieldMs` (standaard 10000): automatisch naar achtergrond na vertraging
- `background` (bool): direct naar achtergrond
- `timeout` (seconden, standaard 1800): beëindigen bij verlopen
- `pty` (bool): uitvoeren in een pseudo-terminal wanneer beschikbaar (TTY-only CLI’s, coding agents, terminal-UI’s)
- `host` (`sandbox | gateway | node`): waar uitvoeren
- `security` (`deny | allowlist | full`): afdwingingsmodus voor `gateway`/`node`
- `ask` (`off | on-miss | always`): goedkeuringsprompts voor `gateway`/`node`
- `node` (string): node-id/naam voor `host=node`
- `elevated` (bool): verzoek om verhoogde modus (Gateway-host); `security=full` wordt alleen afgedwongen wanneer verhoogd oplossen resulteert in `full`

Notities:

- `host` is standaard `sandbox`.
- `elevated` wordt genegeerd wanneer sandboxing uit staat (exec draait al op de host).
- Goedkeuringen voor `gateway`/`node` worden aangestuurd door `~/.openclaw/exec-approvals.json`.
- `node` vereist een gekoppelde node (Companion-app of headless node-host).
- Als meerdere nodes beschikbaar zijn, stel `exec.node` of `tools.exec.node` in om er één te selecteren.
- Op niet-Windows-hosts gebruikt exec `SHELL` wanneer ingesteld; als `SHELL` `fish` is, geeft het de voorkeur aan `bash` (of `sh`)
  uit `PATH` om fish-incompatibele scripts te vermijden, en valt daarna terug op `SHELL` als geen van beide bestaat.
- Hostuitvoering (`gateway`/`node`) weigert `env.PATH` en loader-overschrijvingen (`LD_*`/`DYLD_*`) om
  binaire kaping of geïnjecteerde code te voorkomen.
- Belangrijk: sandboxing staat **standaard uit**. Als sandboxing uit staat, wordt `host=sandbox` direct uitgevoerd op
  de Gateway-host (geen container) en **vereist geen goedkeuringen**. Om goedkeuringen te vereisen, voer uit met
  `host=gateway` en configureer exec-goedkeuringen (of schakel sandboxing in).

## Configuratie

- `tools.exec.notifyOnExit` (standaard: true): wanneer true, plaatsen exec-sessies in de achtergrond een systeemgebeurtenis in de wachtrij en vragen ze een heartbeat bij afsluiten.
- `tools.exec.approvalRunningNoticeMs` (standaard: 10000): emitteert één enkele “running”-melding wanneer een exec met goedkeuringsvereiste langer duurt dan dit (0 schakelt uit).
- `tools.exec.host` (standaard: `sandbox`)
- `tools.exec.security` (standaard: `deny` voor sandbox, `allowlist` voor Gateway + node wanneer niet ingesteld)
- `tools.exec.ask` (standaard: `on-miss`)
- `tools.exec.node` (standaard: niet ingesteld)
- `tools.exec.pathPrepend`: lijst met mappen die voorafgaand aan `PATH` worden toegevoegd voor exec-runs.
- `tools.exec.safeBins`: stdin-only veilige binaries die zonder expliciete allowlist-items mogen draaien.

Voorbeeld:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH-afhandeling

- `host=gateway`: voegt de `PATH` van je login-shell samen in de exec-omgeving. Overschrijvingen van `env.PATH` worden
  geweigerd bij hostuitvoering. De daemon zelf draait nog steeds met een minimale `PATH`:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: voert `sh -lc` (login-shell) uit binnen de container, waardoor `/etc/profile` `PATH` kan resetten.
  OpenClaw voegt `env.PATH` toe na het sourcen van profielen via een interne env-var (geen shell-interpolatie);
  `tools.exec.pathPrepend` is hier ook van toepassing.
- `host=node`: alleen niet-geblokkeerde env-overschrijvingen die je doorgeeft, worden naar de node verzonden. Overschrijvingen van `env.PATH` worden
  geweigerd bij hostuitvoering. Headless node-hosts accepteren `PATH` alleen wanneer het voorafgaat aan het node-host
  PATH (geen vervanging). macOS-nodes laten `PATH`-overschrijvingen volledig vallen.

Per-agent nodebinding (gebruik de agentlijst-index in de config):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Besturings-UI: het tabblad Nodes bevat een klein paneel “Exec node binding” voor dezelfde instellingen.

## Sessie-overschrijvingen (`/exec`)

Gebruik `/exec` om **per sessie** standaardwaarden in te stellen voor `host`, `security`, `ask` en `node`.
Verzend `/exec` zonder argumenten om de huidige waarden te tonen.

Voorbeeld:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Autorisatiemodel

`/exec` wordt alleen gehonoreerd voor **geautoriseerde afzenders** (kanaal-allowlists/koppeling plus `commands.useAccessGroups`).
Het werkt **alleen de sessiestatus** bij en schrijft geen config. Om exec hard uit te schakelen, weiger het via
toolbeleid (`tools.deny: ["exec"]` of per agent). Host-goedkeuringen blijven van toepassing tenzij je expliciet
`security=full` en `ask=off` instelt.

## Exec-goedkeuringen (Companion-app / node-host)

Gesandboxde agents kunnen per verzoek goedkeuring vereisen voordat `exec` op de Gateway- of node-host wordt uitgevoerd.
Zie [Exec approvals](/tools/exec-approvals) voor het beleid, de allowlist en de UI-flow.

Wanneer goedkeuringen vereist zijn, retourneert de exec-tool onmiddellijk met
`status: "approval-pending"` en een goedkeurings-id. Zodra goedgekeurd (of geweigerd / verlopen),
zendt de Gateway systeemgebeurtenissen uit (`Exec finished` / `Exec denied`). Als de opdracht nog
draait na `tools.exec.approvalRunningNoticeMs`, wordt één enkele `Exec running`-melding uitgezonden.

## Allowlist + veilige bins

Allowlist-handhaving matcht **alleen opgeloste binaire paden** (geen basenaam-matches). Wanneer
`security=allowlist`, worden shellopdrachten automatisch toegestaan alleen als elk pijplijnsegment
op de allowlist staat of een veilige bin is. Chaining (`;`, `&&`, `||`) en omleidingen worden geweigerd in
allowlist-modus.

## Voorbeelden

Voorgrond:

```json
{ "tool": "exec", "command": "ls -la" }
```

Achtergrond + poll:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Toetsen verzenden (tmux-stijl):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Verzenden (alleen CR verzenden):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Plakken (standaard bracketed):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (experimenteel)

`apply_patch` is een subtool van `exec` voor gestructureerde bewerkingen over meerdere bestanden.
Schakel het expliciet in:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Notities:

- Alleen beschikbaar voor OpenAI/OpenAI Codex-modellen.
- Toolbeleid blijft van toepassing; `allow: ["exec"]` staat impliciet `apply_patch` toe.
- Configuratie bevindt zich onder `tools.exec.applyPatch`.
