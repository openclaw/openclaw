---
summary: "Användning av Exec-verktyget, stdin-lägen och TTY-stöd"
read_when:
  - Använder eller ändrar exec-verktyget
  - Felsöker stdin- eller TTY-beteende
title: "Exec-verktyg"
x-i18n:
  source_path: tools/exec.md
  source_hash: 3b32238dd8dce93d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:51Z
---

# Exec-verktyg

Kör skalkommandon i arbetsytan. Stöder körning i förgrund + bakgrund via `process`.
Om `process` inte tillåts kör `exec` synkront och ignorerar `yieldMs`/`background`.
Bakgrundssessioner är avgränsade per agent; `process` ser bara sessioner från samma agent.

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
- Viktigt: sandboxing är **av som standard**. Om sandboxing är av körs `host=sandbox` direkt på
  gateway-värden (ingen container) och **kräver inga godkännanden**. För att kräva godkännanden, kör med
  `host=gateway` och konfigurera exec-godkännanden (eller aktivera sandboxing).

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

- `host=gateway`: sammanfogar din inloggningsskals `PATH` i exec-miljön. `env.PATH`-åsidosättningar
  avvisas för värdkörning. Själva daemonen kör fortfarande med en minimal `PATH`:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: kör `sh -lc` (inloggningsskal) i containern, så `/etc/profile` kan återställa `PATH`.
  OpenClaw lägger till `env.PATH` efter profilsourcing via en intern env-var (ingen skalinterpolering);
  `tools.exec.pathPrepend` gäller här också.
- `host=node`: endast icke-blockerade env-åsidosättningar som du skickar vidarebefordras till noden. `env.PATH`-åsidosättningar
  avvisas för värdkörning. Headless nodvärdar accepterar `PATH` endast när den läggs till före nodvärdens
  PATH (ingen ersättning). macOS-noder släpper `PATH`-åsidosättningar helt.

Per-agent-nodbindning (använd agentlistans index i konfig):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Kontroll-UI: fliken Noder innehåller en liten panel ”Exec node binding” för samma inställningar.

## Sessionsåsidosättningar (`/exec`)

Använd `/exec` för att sätta **per-session**-standarder för `host`, `security`, `ask` och `node`.
Skicka `/exec` utan argument för att visa aktuella värden.

Exempel:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Auktorisationsmodell

`/exec` respekteras endast för **auktoriserade avsändare** (kanaltillåtelselistor/parning plus `commands.useAccessGroups`).
Den uppdaterar **endast sessionsstatus** och skriver inte konfig. För att hårdinaktivera exec, neka det via verktygspolicy
(`tools.deny: ["exec"]` eller per agent). Värdgodkännanden gäller fortfarande om du inte uttryckligen sätter
`security=full` och `ask=off`.

## Exec-godkännanden (companion-app / nodvärd)

Sandboxade agenter kan kräva godkännande per begäran innan `exec` körs på gateway- eller nodvärden.
Se [Exec approvals](/tools/exec-approvals) för policy, tillåtelselista och UI-flöde.

När godkännanden krävs returnerar exec-verktyget omedelbart med
`status: "approval-pending"` och ett godkännande-id. När det har godkänts (eller nekats / tidsgräns nåtts),
sänder Gateway systemhändelser (`Exec finished` / `Exec denied`). Om kommandot fortfarande
kör efter `tools.exec.approvalRunningNoticeMs` sänds ett enda `Exec running`-meddelande.

## Tillåtelselista + säkra binärer

Verkställighet av tillåtelselista matchar **endast upplösta binärsökvägar** (inga basnamnsträffar). När
`security=allowlist` är aktivt tillåts skalkommandon automatiskt endast om varje segment i pipelinen är
tillåtelselistan eller en säker binär. Kedjning (`;`, `&&`, `||`) och omdirigeringar avvisas i
tillåtelseläge.

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

`apply_patch` är ett underverktyg till `exec` för strukturerade flerfilsredigeringar.
Aktivera det uttryckligen:

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
