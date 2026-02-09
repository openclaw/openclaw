---
title: Sandbox vs verktygspolicy vs förhöjd
summary: "Varför ett verktyg blockeras: sandbox‑runtime, verktygstillåt/nek‑policy och grindar för förhöjd exec"
read_when: "Du hamnar i ”sandbox jail” eller ser ett verktygs-/förhöjningsavslag och vill veta exakt vilken konfigurationsnyckel som ska ändras."
status: active
---

# Sandbox vs verktygspolicy vs förhöjd

OpenClaw har tre relaterade (men olika) kontroller:

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) avgör **var verktyg körs** (Docker vs värd).
2. **Verktygspolicy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) avgör **vilka verktyg som är tillgängliga/tillåtna**.
3. **Förhöjd** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) är en **endast‑exec nödutgång** för att köra på värden när du är sandboxad.

## Snabb felsökning

Använd inspektören för att se vad OpenClaw _faktiskt_ gör:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Den skriver ut:

- effektivt sandbox‑läge/omfång/åtkomst till arbetsyta
- om sessionen för närvarande är sandboxad (main vs non‑main)
- effektiv tillåt/nek‑policy för sandbox‑verktyg (och om den kommer från agent/global/standard)
- grindar för förhöjd och nyckelvägar för åtgärd

## Sandbox: var verktyg körs

Sandboxing styrs av `agents.defaults.sandbox.mode`:

- `"off"`: allt körs på värden.
- `"non-main"`: endast non‑main‑sessioner är sandboxade (vanlig ”överraskning” för grupper/kanaler).
- `"all"`: allt är sandboxat.

Se [Sandboxing](/gateway/sandboxing) för hela matrisen (omfång, arbetsytemonteringar, images).

### Bind mounts (snabb säkerhetskontroll)

- `docker.binds` _punkterar_ sandboxens filsystem: det du monterar blir synligt i containern med det läge du anger (`:ro` eller `:rw`).
- Standard är läs‑skriv om du utelämnar läget; föredra `:ro` för källkod/hemligheter.
- `scope: "shared"` ignorerar binds per agent (endast globala binds gäller).
- Att binda `/var/run/docker.sock` ger i praktiken värdkontroll till sandboxen; gör detta endast med avsikt.
- Åtkomst till arbetsyta (`workspaceAccess: "ro"`/`"rw"`) är oberoende av bind‑lägen.

## Verktygspolicy: vilka verktyg finns/kan anropas

Två lager är viktiga:

- **Verktygsprofil**: `tools.profile` och `agents.list[].tools.profile` (grundläggande tillåtelselista)
- **Leverantörens verktygsprofil**: `tools.byProvider[provider].profile` och `agents.list[].tools.byProvider[provider].profile`
- **Global/per‑agent verktygspolicy**: `tools.allow`/`tools.deny` och `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Leverantörens verktygspolicy**: `tools.byProvider[provider].allow/deny` och `agents.list[].tools.byProvider[provider].allow/deny`
- **Sandbox‑verktygspolicy** (gäller endast när sandboxad): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` och `agents.list[].tools.sandbox.tools.*`

Tumregler:

- `deny` vinner alltid.
- Om `allow` inte är tom behandlas allt annat som blockerat.
- Verktygspolicyn är den hårda stoppunkten: `/exec` kan inte åsidosätta ett nekat `exec`‑verktyg.
- `/exec` ändrar bara sessionsstandard för auktoriserade avsändare; det ger inte verktygsåtkomst.
  Verktygsnycklar för leverantörer accepterar antingen `provider` (t.ex. `google-antigravity`) eller `provider/model` (t.ex. `openai/gpt-5.2`).

### Verktygsgrupper (förkortningar)

Verktygspolicys (global, agent, sandbox) stödjer `group:*`‑poster som expanderar till flera verktyg:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

Tillgängliga grupper:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alla inbyggda OpenClaw‑verktyg (exkluderar leverantörsplugins)

## Förhöjd: exec‑endast ”kör på värden”

Förhöjd ger **inte** extra verktyg; den påverkar endast `exec`.

- Om du är sandboxad körs `/elevated on` (eller `exec` med `elevated: true`) på värden (godkännanden kan fortfarande krävas).
- Använd `/elevated full` för att hoppa över exec‑godkännanden för sessionen.
- Om du redan kör direkt är förhöjd i praktiken en no‑op (fortfarande grindstyrd).
- Förhöjd är **inte** skill‑omfattad och åsidosätter **inte** tillåt/nek för verktyg.
- `/exec` är separat från förhöjd. Det justerar bara per-session exec standardvärden för auktoriserade avsändare.

Grindar:

- Aktivering: `tools.elevated.enabled` (och valfritt `agents.list[].tools.elevated.enabled`)
- Avsändare tillåter: `tools.elevated.allowFrom.<provider>` (och valfritt `agents.list[].tools.elevated.allowFrom.<provider>`)

Se [Elevated Mode](/tools/elevated).

## Vanliga ”sandbox jail”‑åtgärder

### ”Verktyg X blockeras av sandbox‑verktygspolicyn”

Åtgärdsnycklar (välj en):

- Inaktivera sandbox: `agents.defaults.sandbox.mode=off` (eller per agent `agents.list[].sandbox.mode=off`)
- Tillåt verktyget i sandbox:
  - ta bort det från `tools.sandbox.tools.deny` (eller per agent `agents.list[].tools.sandbox.tools.deny`)
  - eller lägg till det i `tools.sandbox.tools.allow` (eller per‑agent‑tillåt)

### ”Jag trodde detta var main, varför är det sandboxat?”

I `"non-main"` läge, grupp/kanal nycklar är _inte_ huvud. Använd huvudsessionsnyckeln (visas av `sandbox förklaring`) eller växla läge till `"off"`.
