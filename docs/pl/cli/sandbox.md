---
title: CLI Sandbox
summary: "Zarządzanie kontenerami sandbox oraz inspekcja efektywnej polityki sandbox"
read_when: "Gdy zarządzasz kontenerami sandbox lub debugujesz zachowanie sandbox/polityki narzędzi."
status: active
---

# CLI Sandbox

Zarządzaj opartymi na Dockerze kontenerami sandbox do izolowanego wykonywania agentów.

## Przegląd

OpenClaw może uruchamiać agentów w izolowanych kontenerach Docker ze względów bezpieczeństwa. Polecenia `sandbox` pomagają zarządzać tymi kontenerami, szczególnie po aktualizacjach lub zmianach konfiguracji.

## Polecenia

### `openclaw sandbox explain`

Sprawdź **efektywny** tryb/zakres/dostęp do obszaru roboczego sandbox, politykę narzędzi sandbox oraz podniesione bramy (z kluczami konfiguracji „fix-it”).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Wyświetl listę wszystkich kontenerów sandbox wraz z ich stanem i konfiguracją.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**Wyjście zawiera:**

- Nazwę kontenera i stan (uruchomiony/zatrzymany)
- Obraz Dockera i informację, czy odpowiada konfiguracji
- Wiek (czas od utworzenia)
- Czas bezczynności (czas od ostatniego użycia)
- Powiązaną sesję/agenta

### `openclaw sandbox recreate`

Usuń kontenery sandbox, aby wymusić ich ponowne utworzenie z aktualnymi obrazami/konfiguracją.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Opcje:**

- `--all`: Odtwórz wszystkie kontenery sandbox
- `--session <key>`: Odtwórz kontener dla konkretnej sesji
- `--agent <id>`: Odtwórz kontenery dla konkretnego agenta
- `--browser`: Odtwórz tylko kontenery przeglądarki
- `--force`: Pomiń prośbę o potwierdzenie

**Ważne:** Kontenery są automatycznie odtwarzane przy następnym użyciu agenta.

## Przypadki użycia

### Po aktualizacji obrazów Dockera

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### Po zmianie konfiguracji sandbox

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### Po zmianie setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### Tylko dla konkretnego agenta

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Dlaczego jest to potrzebne?

**Problem:** Gdy aktualizujesz obrazy Dockera sandbox lub konfigurację:

- Istniejące kontenery nadal działają ze starymi ustawieniami
- Kontenery są czyszczone dopiero po 24 h bezczynności
- Często używani agenci utrzymują stare kontenery bezterminowo

**Rozwiązanie:** Użyj `openclaw sandbox recreate`, aby wymusić usunięcie starych kontenerów. Zostaną one automatycznie odtworzone z aktualnymi ustawieniami przy następnym użyciu.

Wskazówka: preferuj `openclaw sandbox recreate` zamiast ręcznego `docker rm`. Wykorzystuje ono nazewnictwo kontenerów Gateway i unika niezgodności, gdy zmieniają się klucze zakresu/sesji.

## Konfiguracja

Ustawienia sandbox znajdują się w `~/.openclaw/openclaw.json` pod `agents.defaults.sandbox` (nadpisania per-agent znajdują się w `agents.list[].sandbox`):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## Zobacz także

- [Dokumentacja Sandbox](/gateway/sandboxing)
- [Konfiguracja agenta](/concepts/agent-workspace)
- [Polecenie Doctor](/gateway/doctor) — sprawdź konfigurację sandbox
