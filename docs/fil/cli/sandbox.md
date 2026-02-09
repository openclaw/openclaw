---
title: Sandbox CLI
summary: "Pamahalaan ang mga sandbox container at siyasatin ang epektibong sandbox policy"
read_when: "Pinamamahalaan mo ang mga sandbox container o nagde-debug ng gawi ng sandbox/tool-policy."
status: active
---

# Sandbox CLI

Pamahalaan ang mga Docker-based na sandbox container para sa hiwalay na pagpapatakbo ng agent.

## Pangkalahatang-ideya

Maaaring patakbuhin ng OpenClaw ang mga agent sa mga hiwalay na Docker container para sa seguridad. Tinutulungan ka ng mga `sandbox` command na pamahalaan ang mga container na ito, lalo na pagkatapos ng mga update o pagbabago sa configuration.

## Mga command

### `openclaw sandbox explain`

Siyasatin ang **epektibong** sandbox mode/scope/workspace access, sandbox tool policy, at mga elevated gate (na may mga fix-it config key path).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Ilista ang lahat ng sandbox container kasama ang kanilang status at config.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**Kasama sa output ang:**

- Pangalan ng container at status (running/stopped)
- Docker image at kung tumutugma ito sa config
- Edad (oras mula nang malikha)
- Idle time (oras mula noong huling paggamit)
- Kaugnay na session/agent

### `openclaw sandbox recreate`

Alisin ang mga sandbox container upang piliting muling malikha gamit ang mga na-update na image/config.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Mga opsyon:**

- `--all`: Muling likhain ang lahat ng sandbox container
- `--session <key>`: Muling likhain ang container para sa partikular na session
- `--agent <id>`: Muling likhain ang mga container para sa partikular na agent
- `--browser`: Muling likhain lamang ang mga browser container
- `--force`: Laktawan ang confirmation prompt

**Mahalaga:** Awtomatikong muling nalilikha ang mga container kapag ginamit muli ang agent.

## Mga use case

### Pagkatapos mag-update ng mga Docker image

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### Pagkatapos baguhin ang sandbox configuration

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### Pagkatapos baguhin ang setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### Para sa partikular na agent lamang

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Bakit ito kailangan?

**Problema:** Kapag nag-update ka ng mga sandbox Docker image o config:

- Patuloy na tumatakbo ang mga umiiral na container gamit ang lumang mga setting
- Ang mga container ay tina-trim lamang matapos ang 24h ng kawalan ng aktibidad
- Ang mga agent na regular na ginagamit ay nagpapanatiling tumatakbo ang mga lumang container nang walang hanggan

**Solusyon:** Gamitin ang `openclaw sandbox recreate` upang pilitin ang pagtanggal ng mga lumang container. Awtomatiko silang muling lilikhain gamit ang kasalukuyang mga setting kapag muling kinailangan.

Tip: mas piliin ang `openclaw sandbox recreate` kaysa sa manu-manong `docker rm`. Ginagamit nito ang
pangalanan ng container ng Gateway at iniiwasan ang mga mismatch kapag nagbago ang scope/session keys.

## Konpigurasyon

Matatagpuan ang mga sandbox setting sa `~/.openclaw/openclaw.json` sa ilalim ng `agents.defaults.sandbox` (ang mga per-agent override ay inilalagay sa `agents.list[].sandbox`):

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

## Tingnan din

- [Sandbox Documentation](/gateway/sandboxing)
- [Agent Configuration](/concepts/agent-workspace)
- [Doctor Command](/gateway/doctor) - Suriin ang setup ng sandbox
