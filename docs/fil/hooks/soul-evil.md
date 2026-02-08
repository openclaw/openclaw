---
summary: "SOUL Evil hook (ipalit ang SOUL.md sa SOUL_EVIL.md)"
read_when:
  - Gusto mong paganahin o i-tune ang SOUL Evil hook
  - Gusto mo ng purge window o random-chance na pagpapalit ng persona
title: "SOUL Evil Hook"
x-i18n:
  source_path: hooks/soul-evil.md
  source_hash: 32aba100712317d1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:31Z
---

# SOUL Evil Hook

Ang SOUL Evil hook ay nagpapalit ng **injected** na `SOUL.md` na nilalaman sa `SOUL_EVIL.md` sa loob ng
isang purge window o sa pamamagitan ng random na tsansa. **Hindi** nito binabago ang mga file sa disk.

## Paano Ito Gumagana

Kapag tumatakbo ang `agent:bootstrap`, maaaring palitan ng hook ang `SOUL.md` na nilalaman sa memory
bago buuin ang system prompt. Kung ang `SOUL_EVIL.md` ay wala o walang laman,
naglolog ang OpenClaw ng babala at pinananatili ang normal na `SOUL.md`.

Ang mga sub-agent run ay **hindi** kasama ang `SOUL.md` sa kanilang mga bootstrap file, kaya
walang epekto ang hook na ito sa mga sub-agent.

## Paganahin

```bash
openclaw hooks enable soul-evil
```

Pagkatapos, itakda ang config:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

Likhain ang `SOUL_EVIL.md` sa root ng agent workspace (katabi ng `SOUL.md`).

## Mga Opsyon

- `file` (string): alternatibong SOUL filename (default: `SOUL_EVIL.md`)
- `chance` (number 0–1): random na tsansa bawat run na gamitin ang `SOUL_EVIL.md`
- `purge.at` (HH:mm): araw-araw na simula ng purge (24-oras na format)
- `purge.duration` (duration): haba ng window (hal. `30s`, `10m`, `1h`)

**Precedence:** ang purge window ang nangingibabaw kaysa sa tsansa.

**Timezone:** gumagamit ng `agents.defaults.userTimezone` kapag naka-set; kung hindi, timezone ng host.

## Mga Tala

- Walang anumang file na sinusulat o binabago sa disk.
- Kung ang `SOUL.md` ay wala sa bootstrap list, walang gagawin ang hook.

## Tingnan Din

- [Hooks](/automation/hooks)
