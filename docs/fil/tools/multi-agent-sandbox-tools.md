---
summary: "Per-agent na sandbox + mga restriksyon sa tool, precedence, at mga halimbawa"
title: Multi-Agent Sandbox at Mga Tool
read_when: "Gusto mo ng per-agent sandboxing o per-agent na mga patakaran sa pagpayag/pagtanggi ng tool sa isang multi-agent gateway."
status: active
---

# Konpigurasyon ng Multi-Agent Sandbox at Mga Tool

## Pangkalahatang-ideya

Ang bawat agent sa isang multi-agent setup ay maaari nang magkaroon ng sarili nitong:

- **Konpigurasyon ng Sandbox** (`agents.list[].sandbox` overrides `agents.defaults.sandbox`)
- **Mga restriksyon sa Tool** (`tools.allow` / `tools.deny`, kasama ang `agents.list[].tools`)

Pinapayagan nito ang pagpapatakbo ng maraming agent na may magkakaibang security profile:

- Personal assistant na may buong access
- Mga agent para sa pamilya/trabaho na may limitadong tool
- Mga public-facing agent na nasa sandbox

Ang `setupCommand` ay kabilang sa ilalim ng `sandbox.docker` (global o per-agent) at tumatakbo nang isang beses kapag nalikha ang container.

Per-agent ang auth: bawat agent ay nagbabasa mula sa sarili nitong `agentDir` auth store sa:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Credentials are **not** shared between agents. 12. Huwag kailanman muling gamitin ang `agentDir` sa iba't ibang agent.
13. Kung gusto mong magbahagi ng creds, kopyahin ang `auth-profiles.json` papunta sa `agentDir` ng ibang agent.

14. Para sa kung paano kumikilos ang sandboxing sa runtime, tingnan ang [Sandboxing](/gateway/sandboxing).
15. Para sa pag-debug ng “bakit ito naka-block?”, tingnan ang [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) at `openclaw sandbox explain`.

---

## Mga Halimbawa ng Konpigurasyon

### Halimbawa 1: Personal + Restricted na Family Agent

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

**Resulta:**

- `main` agent: Tumatakbo sa host, buong access sa tool
- `family` agent: Tumatakbo sa Docker (isang container bawat agent), tanging `read` tool

---

### Halimbawa 2: Work Agent na may Shared Sandbox

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

### Halimbawa 2b: Global coding profile + messaging-only na agent

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

**Resulta:**

- ang mga default agent ay nakakakuha ng mga coding tool
- ang `support` agent ay messaging-only (+ Slack tool)

---

### Halimbawa 3: Iba’t ibang Sandbox Mode kada Agent

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

## Precedence ng Konpigurasyon

Kapag may parehong global (`agents.defaults.*`) at agent-specific (`agents.list[].*`) na config:

### Sandbox Config

Ina-override ng agent-specific na mga setting ang global:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Mga tala:**

- Ang `agents.list[].sandbox.{docker,browser,prune}.*` ay nag-o-override sa `agents.defaults.sandbox.{docker,browser,prune}.*` para sa agent na iyon (binabalewala kapag ang sandbox scope ay nag-resolve sa `"shared"`).

### Mga Restriksyon sa Tool

Ang pagkakasunud-sunod ng pag-filter ay:

1. **Tool profile** (`tools.profile` o `agents.list[].tools.profile`)
2. **Provider tool profile** (`tools.byProvider[provider].profile` o `agents.list[].tools.byProvider[provider].profile`)
3. **Global tool policy** (`tools.allow` / `tools.deny`)
4. **Provider tool policy** (`tools.byProvider[provider].allow/deny`)
5. **Agent-specific tool policy** (`agents.list[].tools.allow/deny`)
6. **Agent provider policy** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Sandbox tool policy** (`tools.sandbox.tools` o `agents.list[].tools.sandbox.tools`)
8. **Subagent tool policy** (`tools.subagents.tools`, kung naaangkop)

16) Ang bawat antas ay maaaring higit pang maghigpit ng mga tool, ngunit hindi maaaring ibalik ang mga tool na tinanggihan na sa mga naunang antas.
    If `agents.list[].tools.sandbox.tools` is set, it replaces `tools.sandbox.tools` for that agent.
17) Kung nakatakda ang `agents.list[].tools.profile`, ino-override nito ang `tools.profile` para sa agent na iyon.
18) Tumatanggap ang mga provider tool key ng alinman sa `provider` (hal. `google-antigravity`) o `provider/model` (hal. `openai/gpt-5.2`).

### Mga tool group (shorthands)

Sinusuportahan ng mga tool policy (global, agent, sandbox) ang mga entry na `group:*` na lumalawak sa maraming konkretong tool:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: lahat ng built-in na OpenClaw tools (hindi kasama ang provider plugins)

### Elevated Mode

`tools.elevated` is the global baseline (sender-based allowlist). 19. Ang `agents.list[].tools.elevated` ay maaaring higit pang maghigpit ng elevated para sa mga partikular na agent (parehong dapat payagan).

Mga pattern sa mitigasyon:

- I-deny ang `exec` para sa mga hindi pinagkakatiwalaang agent (`agents.list[].tools.deny: ["exec"]`)
- Iwasang i-allowlist ang mga sender na nagru-route sa mga restricted na agent
- I-disable ang elevated sa global (`tools.elevated.enabled: false`) kung sandboxed execution lang ang gusto mo
- I-disable ang elevated per agent (`agents.list[].tools.elevated.enabled: false`) para sa mga sensitibong profile

---

## Migrasyon mula sa Single Agent

**Bago (single agent):**

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

**Pagkatapos (multi-agent na may iba’t ibang profile):**

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

Ang mga legacy na `agent.*` config ay mina-migrate ng `openclaw doctor`; mas mainam na gamitin ang `agents.defaults` + `agents.list` sa susunod.

---

## Mga Halimbawa ng Restriksyon sa Tool

### Read-only na Agent

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### Safe Execution na Agent (walang pagbabago sa file)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Communication-only na Agent

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## Karaniwang Pitfall: "non-main"

20. Ang `agents.defaults.sandbox.mode: "non-main"` ay nakabatay sa `session.mainKey` (default na `"main"`), hindi sa agent id. 21. Ang mga session ng group/channel ay palaging nakakakuha ng sarili nilang mga key, kaya itinuturing silang non-main at isasailalim sa sandbox. 22. Kung gusto mong ang isang agent ay hindi kailanman ma-sandbox, itakda ang `agents.list[].sandbox.mode: "off"`.

---

## Pagsusuri

Pagkatapos i-configure ang multi-agent sandbox at mga tool:

1. **Suriin ang agent resolution:**

   ```exec
   openclaw agents list --bindings
   ```

2. **I-verify ang mga sandbox container:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Subukan ang mga restriksyon sa tool:**
   - Magpadala ng mensaheng nangangailangan ng mga restricted na tool
   - Tiyaking hindi magagamit ng agent ang mga tinanggihang tool

4. **I-monitor ang mga log:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Pag-troubleshoot

### Hindi naka-sandbox ang agent kahit may `mode: "all"`

- Suriin kung may global na `agents.defaults.sandbox.mode` na nag-o-override nito
- May precedence ang agent-specific na config, kaya i-set ang `agents.list[].sandbox.mode: "all"`

### Available pa rin ang mga tool kahit may deny list

- Suriin ang pagkakasunud-sunod ng pag-filter ng tool: global → agent → sandbox → subagent
- Ang bawat antas ay maaari lamang magdagdag ng restriksyon, hindi magbalik
- I-verify gamit ang mga log: `[tools] filtering tools for agent:${agentId}`

### Hindi isolated ang container kada agent

- I-set ang `scope: "agent"` sa agent-specific na sandbox config
- Ang default ay `"session"` na lumilikha ng isang container kada session

---

## Tingnan Din

- [Multi-Agent Routing](/concepts/multi-agent)
- [Konpigurasyon ng Sandbox](/gateway/configuration#agentsdefaults-sandbox)
- [Pamamahala ng Session](/concepts/session)
