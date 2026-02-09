---
summary: "Sandbox na agenta + ograniczenia narzędzi, priorytety i przykłady"
title: Sandbox i narzędzia dla wielu agentów
read_when: "Chcesz sandboxing per agent lub zasady zezwalania/odmowy narzędzi per agent w bramie wieloagentowej."
status: active
---

# Konfiguracja sandboxa i narzędzi dla wielu agentów

## Przegląd

Każdy agent w konfiguracji wieloagentowej może teraz mieć własne:

- **Ustawienia sandboxa** (`agents.list[].sandbox` zastępuje `agents.defaults.sandbox`)
- **Ograniczenia narzędzi** (`tools.allow` / `tools.deny`, plus `agents.list[].tools`)

Umożliwia to uruchamianie wielu agentów z różnymi profilami bezpieczeństwa:

- Asystent osobisty z pełnym dostępem
- Agenci rodzinny/służbowy z ograniczonymi narzędziami
- Agenci publiczni uruchamiani w sandboxach

`setupCommand` należy umieścić pod `sandbox.docker` (globalnie lub per agent) i jest wykonywane jednokrotnie
podczas tworzenia kontenera.

Uwierzytelnianie jest per agent: każdy agent odczytuje z własnego magazynu uwierzytelniania `agentDir` pod adresem:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Poświadczenia **nie** są współdzielone między agentami. Nigdy nie używaj ponownie `agentDir` między agentami.
Jeśli chcesz współdzielić poświadczenia, skopiuj `auth-profiles.json` do `agentDir` drugiego agenta.

Aby dowiedzieć się, jak sandboxing zachowuje się w czasie działania, zobacz [Sandboxing](/gateway/sandboxing).
Do debugowania „dlaczego to jest zablokowane?” zobacz [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) oraz `openclaw sandbox explain`.

---

## Przykłady konfiguracji

### Przykład 1: Agent osobisty + ograniczony agent rodzinny

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
        "workspace": "~/.openclaw/workspace-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

**Wynik:**

- Agent `main`: działa na hoście, pełny dostęp do narzędzi
- Agent `family`: działa w Dockerze (jeden kontener na agenta), tylko narzędzie `read`

---

### Przykład 2: Agent służbowy ze współdzielonym sandboxem

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/.openclaw/workspace-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/.openclaw/workspace-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "apply_patch", "exec"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### Przykład 2b: Globalny profil programistyczny + agent tylko do komunikacji

```json
{
  "tools": { "profile": "coding" },
  "agents": {
    "list": [
      {
        "id": "support",
        "tools": { "profile": "messaging", "allow": ["slack"] }
      }
    ]
  }
}
```

**Wynik:**

- domyślni agenci otrzymują narzędzia programistyczne
- agent `support` jest tylko do komunikacji (+ narzędzie Slack)

---

### Przykład 3: Różne tryby sandboxa per agent

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Override: public always sandboxed
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

---

## Priorytet konfiguracji

Gdy istnieją zarówno konfiguracje globalne (`agents.defaults.*`), jak i specyficzne dla agenta (`agents.list[].*`):

### Konfiguracja sandboxa

Ustawienia specyficzne dla agenta nadpisują globalne:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Uwagi:**

- `agents.list[].sandbox.{docker,browser,prune}.*` zastępuje `agents.defaults.sandbox.{docker,browser,prune}.*` dla tego agenta (ignorowane, gdy zakres sandboxa rozwiązuje się do `"shared"`).

### Ograniczenia narzędzi

Kolejność filtrowania jest następująca:

1. **Profil narzędzi** (`tools.profile` lub `agents.list[].tools.profile`)
2. **Profil narzędzi dostawcy** (`tools.byProvider[provider].profile` lub `agents.list[].tools.byProvider[provider].profile`)
3. **Globalna polityka narzędzi** (`tools.allow` / `tools.deny`)
4. **Polityka narzędzi dostawcy** (`tools.byProvider[provider].allow/deny`)
5. **Polityka narzędzi specyficzna dla agenta** (`agents.list[].tools.allow/deny`)
6. **Polityka dostawcy agenta** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Polityka narzędzi sandboxa** (`tools.sandbox.tools` lub `agents.list[].tools.sandbox.tools`)
8. **Polityka narzędzi subagenta** (`tools.subagents.tools`, jeśli dotyczy)

Każdy poziom może dodatkowo ograniczać narzędzia, ale nie może przywracać narzędzi odrzuconych na wcześniejszych poziomach.
Jeśli ustawiono `agents.list[].tools.sandbox.tools`, zastępuje ono `tools.sandbox.tools` dla tego agenta.
Jeśli ustawiono `agents.list[].tools.profile`, nadpisuje ono `tools.profile` dla tego agenta.
Klucze narzędzi dostawcy akceptują zarówno `provider` (np. `google-antigravity`), jak i `provider/model` (np. `openai/gpt-5.2`).

### Grupy narzędzi (skróty)

Polityki narzędzi (globalne, agenta, sandboxa) obsługują wpisy `group:*`, które rozwijają się do wielu konkretnych narzędzi:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: wszystkie wbudowane narzędzia OpenClaw (z wyłączeniem wtyczek dostawców)

### Tryb Elevated

`tools.elevated` jest globalną bazą (lista dozwolonych oparta na nadawcy). `agents.list[].tools.elevated` może dodatkowo ograniczać tryb elevated dla konkretnych agentów (oba muszą zezwalać).

Wzory łagodzenia:

- Odrzuć `exec` dla niezaufanych agentów (`agents.list[].tools.deny: ["exec"]`)
- Unikaj dodawania do listy dozwolonych nadawców, którzy kierują ruch do agentów z ograniczeniami
- Wyłącz tryb elevated globalnie (`tools.elevated.enabled: false`), jeśli chcesz wyłącznie wykonanie w sandboxie
- Wyłącz tryb elevated per agent (`agents.list[].tools.elevated.enabled: false`) dla wrażliwych profili

---

## Migracja z pojedynczego agenta

**Przed (pojedynczy agent):**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "apply_patch", "exec"],
        "deny": []
      }
    }
  }
}
```

**Po (wielu agentów z różnymi profilami):**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

Starsze konfiguracje `agent.*` są migrowane przez `openclaw doctor`; na przyszłość preferuj `agents.defaults` + `agents.list`.

---

## Przykłady ograniczeń narzędzi

### Agent tylko do odczytu

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### Agent bezpiecznego wykonania (bez modyfikacji plików)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Agent tylko do komunikacji

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## Częsta pułapka: „non-main”

`agents.defaults.sandbox.mode: "non-main"` opiera się na `session.mainKey` (domyślnie `"main"`),
a nie na identyfikatorze agenta. Sesje grupowe/kanałowe zawsze otrzymują własne klucze,
więc są traktowane jako non-main i będą uruchamiane w sandboxie. Jeśli chcesz, aby agent nigdy
nie był sandboxowany, ustaw `agents.list[].sandbox.mode: "off"`.

---

## Testowanie

Po skonfigurowaniu sandboxa i narzędzi dla wielu agentów:

1. **Sprawdź rozpoznawanie agenta:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Zweryfikuj kontenery sandboxa:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Przetestuj ograniczenia narzędzi:**
   - Wyślij wiadomość wymagającą narzędzi objętych ograniczeniami
   - Zweryfikuj, że agent nie może użyć narzędzi zabronionych

4. **Monitoruj logi:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Rozwiązywanie problemów

### Agent nie jest sandboxowany mimo `mode: "all"`

- Sprawdź, czy istnieje globalne `agents.defaults.sandbox.mode`, które to nadpisuje
- Konfiguracja specyficzna dla agenta ma pierwszeństwo, więc ustaw `agents.list[].sandbox.mode: "all"`

### Narzędzia nadal dostępne mimo listy odmów

- Sprawdź kolejność filtrowania narzędzi: globalna → agent → sandbox → subagent
- Każdy poziom może tylko dodatkowo ograniczać, nie przywracać
- Zweryfikuj w logach: `[tools] filtering tools for agent:${agentId}`

### Kontener nie jest izolowany per agent

- Ustaw `scope: "agent"` w konfiguracji sandboxa specyficznej dla agenta
- Domyślnie jest to `"session"`, co tworzy jeden kontener na sesję

---

## Zobacz także

- [Routing wieloagentowy](/concepts/multi-agent)
- [Konfiguracja sandboxa](/gateway/configuration#agentsdefaults-sandbox)
- [Zarządzanie sesją](/concepts/session)
