---
summary: "Användning av Exec-verktyget, stdin-lägen och TTY-stöd"
read_when:
  - Använder eller ändrar exec-verktyget
  - Felsöker stdin- eller TTY-beteende
title: "Exec-verktyg"
---

# Exec-verktyg

Kör shell‑kommandon i arbetsytan. Stöder förgrund + bakgrunds körning via `process`.
Om `process` inte är tillåtet körs `exec` synkront och ignorerar `yieldMs`/`background`.
Bakgrundssessioner är omfattade per agent; `process` ser bara sessioner från samma agent.

## Parametrar

- `command` (krävs)
- `workdir` (standard: cwd)
- `env` (nyckel/värde-åsidosättningar)
- `yieldMs` (standard 10000): auto-bakgrund efter fördröjning
- `background` (bool): bakgrund direkt
- `timeout` (sekunder, standard 1800): döda vid utgång
- `pty` (bool): kör i en pseudo-terminal när tillgänglig (endast TTY-CLI:er, kodande agenter, terminalgränssnitt)
- `host` (`sandbox | gateway | node`): var exekvering sker
- `security` (`deny | allowlist | full`): verkställighetsläge för `gateway`/`node`
- `ask` (`off | on-miss | always`): godkännandepromptar för `gateway`/`node`
- `node` (sträng): nod-id/-namn för `host=node`
- `elevated` (bool): begär förhöjt läge (gateway-värd); `security=full` framtvingas endast när förhöjning löses till `full`

Noteringar:

- `host` är som standard `sandbox`.
- `elevated` ignoreras när sandboxing är av (exec kör redan på värden).
- `gateway`/`node`-godkännanden styrs av `~/.openclaw/exec-approvals.json`.
- `node` kräver en parad nod (companion-app eller headless nodvärd).
- Om flera noder är tillgängliga, sätt `exec.node` eller `tools.exec.node` för att välja en.
- På icke-Windows-värdar använder exec `SHELL` när satt; om `SHELL` är `fish` föredras `bash` (eller `sh`)
  från `PATH` för att undvika fish-inkompatibla skript, och faller sedan tillbaka till `SHELL` om ingen finns.
- Värdkörning (`gateway`/`node`) avvisar `env.PATH` och loader-åsidosättningar (`LD_*`/`DYLD_*`) för att
  förhindra binärkapning eller injicerad kod.
- Viktigt: sandlådan är **av som standard**. Om sandboxning är avstängd körs `host=sandbox` direkt på
  gatewayvärden (ingen behållare) och **kräver inte godkännanden**. För att kräva godkännanden, kör med
  `host=gateway` och konfigurera exec-godkännanden (eller aktivera sandboxning).

## Konfig

- `tools.exec.notifyOnExit` (standard: true): när true köar bakgrundskörda exec-sessioner en systemhändelse och begär ett heartbeat vid avslut.
- `tools.exec.approvalRunningNoticeMs` (standard: 10000): sänder ett enda ”kör”-meddelande när en exec som kräver godkännande kör längre än detta (0 inaktiverar).
- `tools.exec.host` (standard: `sandbox`)
- `tools.exec.security` (standard: `deny` för sandbox, `allowlist` för gateway + nod när ej satt)
- `tools.exec.ask` (standard: `on-miss`)
- `tools.exec.node` (standard: ej satt)
- `tools.exec.pathPrepend`: lista över kataloger som ska läggas till före `PATH` för exec-körningar.
- `tools.exec.safeBins`: stdin-only säkra binärer som kan köras utan explicita poster i tillåtelselistan.

Exempel:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH-hantering

- `host=gateway`: sammanfogar ditt login-shell `PATH` till exec-miljön. `env.PATH` overrides are
  rejected for host execution. Själva daemonen körs fortfarande med en minimal `PATH`:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: kör `sh -lc` (login shell) inuti behållaren, så `/etc/profile` kan återställa `PATH`.
  OpenClaw låtsas som `env.PATH` efter profilinköp via en intern env var (ingen skalinterpolation);
  `tools.exec.pathPrepend` gäller även här.
- `host=node`: endast icke-blockerade env överskrider du skickar till noden. `env.PATH` overrides are
  rejected for host execution. Huvudlösa nodvärdar accepterar `PATH` endast när det föregår noden värd
  PATH (ingen ersättning). macOS noder släpper 'PATH' åsidosätter helt.

Per-agent-nodbindning (använd agentlistans index i konfig):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Kontroll-UI: fliken Noder innehåller en liten panel ”Exec node binding” för samma inställningar.

## Sessionsåsidosättningar (`/exec`)

Använd `/exec` för att sätta **per-session** standardvärden för `host`, `security`, `ask` och `node`.
Skicka `/exec` utan argument för att visa aktuella värden.

Exempel:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Auktorisationsmodell

`/exec` hedras endast för **auktoriserade avsändare** (kanaltillåtna listor/parkoppling plus `commands.useAccessGroups`).
Den uppdaterar **sessionsstaten endast** och skriver inte konfiguration. För att hård-disable exec, neka det via verktyget
policy (`tools.deny: ["exec"]` eller per-agent). Värdgodkännanden gäller fortfarande om du inte uttryckligen anger
`security=full` och `ask=off`.

## Exec-godkännanden (companion-app / nodvärd)

Sandboxade agenter kan kräva godkännande per begäran innan `exec` körs på gateway eller nod värd.
Se [Exec godkännanden](/tools/exec-approvals) för policy, allowlist och UI flöde.

När godkännanden krävs returnerar exec-verktyget omedelbart med
`status: "approval-pending"` och ett godkännande-id. En gång godkänd (eller nekad / tidsinställd ut),
Gateway avger systemhändelser (`Exec avslutad` / `Exec nekad`). Om kommandot fortfarande körs
efter `tools.exec.approvalRunningNoticeMs`, avges ett enda `Exec running`-meddelande.

## Tillåtelselista + säkra binärer

Tillåtna verkställighet matchar **lösta binära sökvägar endast** (inget basnamn matchar). När
`security=allowlist`, skalkommandon tillåts endast automatiskt om varje rörledningssegment är
tillåten eller en säker behållare. Kedjning (`;`, `&&`, `<unk> `) och omdirigering avvisas i
tillåten lista.

## Exempel

Förgrund:

```json
{ "tool": "exec", "command": "ls -la" }
```

Bakgrund + polling:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Skicka tangenter (tmux-stil):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Skicka (endast CR):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Klistra in (hakparenteser som standard):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (experimentell)

`apply_patch` är ett underverktyg till `exec` för strukturerade multi-filredigeringar.
Aktivera det uttryckligt:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Noteringar:

- Endast tillgängligt för OpenAI/OpenAI Codex-modeller.
- Verktygspolicy gäller fortfarande; `allow: ["exec"]` tillåter implicit `apply_patch`.
- Konfig finns under `tools.exec.applyPatch`.
