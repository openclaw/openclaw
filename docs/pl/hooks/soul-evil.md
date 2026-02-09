---
summary: "Hook SOUL Evil (zamiana SOUL.md na SOUL_EVIL.md)"
read_when:
  - Chcesz włączyć lub dostroić hook SOUL Evil
  - Chcesz okno czyszczenia lub losową zamianę persony
title: "Hook SOUL Evil"
---

# Hook SOUL Evil

Hook SOUL Evil zamienia **wstrzykniętą** treść `SOUL.md` na `SOUL_EVIL.md` podczas
okna czyszczenia lub losowo. **Nie** modyfikuje plików na dysku.

## Jak to działa

Gdy uruchamia się `agent:bootstrap`, hook może zastąpić treść `SOUL.md` w pamięci
przed złożeniem promptu systemowego. Jeśli `SOUL_EVIL.md` jest brakujący lub pusty,
OpenClaw zapisuje ostrzeżenie i zachowuje normalny `SOUL.md`.

Uruchomienia podagentów **nie** zawierają `SOUL.md` w swoich plikach bootstrap,
więc ten hook nie ma wpływu na podagentów.

## Włączanie

```bash
openclaw hooks enable soul-evil
```

Następnie ustaw konfigurację:

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

Utwórz `SOUL_EVIL.md` w katalogu głównym obszaru roboczego agenta (obok `SOUL.md`).

## Opcje

- `file` (string): alternatywna nazwa pliku SOUL (domyślnie: `SOUL_EVIL.md`)
- `chance` (liczba 0–1): losowa szansa na uruchomienie, aby użyć `SOUL_EVIL.md`
- `purge.at` (HH:mm): dzienny początek czyszczenia (zegar 24‑godzinny)
- `purge.duration` (czas trwania): długość okna (np. `30s`, `10m`, `1h`)

**Pierwszeństwo:** okno czyszczenia ma pierwszeństwo przed losowością.

**Strefa czasowa:** używa `agents.defaults.userTimezone` jeśli ustawione; w przeciwnym razie strefy czasowej hosta.

## Uwagi

- Żadne pliki nie są zapisywane ani modyfikowane na dysku.
- Jeśli `SOUL.md` nie znajduje się na liście bootstrap, hook nic nie robi.

## Zobacz także

- [Hooks](/automation/hooks)
