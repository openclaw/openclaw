---
summary: "Hur OpenClaw sandboxing fungerar: lägen, omfång, åtkomst till arbetsyta och images"
title: Sandboxing
read_when: "Du vill ha en dedikerad förklaring av sandboxing eller behöver justera agents.defaults.sandbox."
status: active
x-i18n:
  source_path: gateway/sandboxing.md
  source_hash: c1bb7fd4ac37ef73
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:37Z
---

# Sandboxing

OpenClaw kan köra **verktyg inuti Docker-containrar** för att minska sprängradien.
Detta är **valfritt** och styrs av konfiguration (`agents.defaults.sandbox` eller
`agents.list[].sandbox`). Om sandboxing är avstängt körs verktyg på värden.
Gateway stannar på värden; verktygskörning sker i en isolerad sandbox
när den är aktiverad.

Detta är inte en perfekt säkerhetsgräns, men den begränsar i praktiken åtkomst till
filsystem och processer när modellen gör något dumt.

## Vad som sandlådas

- Verktygskörning (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, etc.).
- Valfri sandlådad webbläsare (`agents.defaults.sandbox.browser`).
  - Som standard startar sandbox‑webbläsaren automatiskt (säkerställer att CDP är nåbart) när webbläsarverktyget behöver den.
    Konfigurera via `agents.defaults.sandbox.browser.autoStart` och `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` låter sandlådade sessioner explicit rikta sig mot värdens webbläsare.
  - Valfria tillåtelselistor styr `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Inte sandlådat:

- Själva Gateway‑processen.
- Alla verktyg som uttryckligen tillåts att köras på värden (t.ex. `tools.elevated`).
  - **Förhöjd exec körs på värden och kringgår sandboxing.**
  - Om sandboxing är avstängt ändrar `tools.elevated` inte körningen (redan på värden). Se [Elevated Mode](/tools/elevated).

## Lägen

`agents.defaults.sandbox.mode` styr **när** sandboxing används:

- `"off"`: ingen sandboxing.
- `"non-main"`: sandlåda endast **icke‑huvud**‑sessioner (standard om du vill ha normala chattar på värden).
- `"all"`: varje session körs i en sandbox.
  Obs: `"non-main"` baseras på `session.mainKey` (standard `"main"`), inte agent‑id.
  Grupp-/kanalsessioner använder egna nycklar, så de räknas som icke‑huvud och kommer att sandlådas.

## Omfång

`agents.defaults.sandbox.scope` styr **hur många containrar** som skapas:

- `"session"` (standard): en container per session.
- `"agent"`: en container per agent.
- `"shared"`: en container delas av alla sandlådade sessioner.

## Åtkomst till arbetsyta

`agents.defaults.sandbox.workspaceAccess` styr **vad sandboxen kan se**:

- `"none"` (standard): verktyg ser en sandbox‑arbetsyta under `~/.openclaw/sandboxes`.
- `"ro"`: monterar agentens arbetsyta skrivskyddad på `/agent` (inaktiverar `write`/`edit`/`apply_patch`).
- `"rw"`: monterar agentens arbetsyta läs/skriv på `/workspace`.

Inkommande media kopieras till den aktiva sandbox‑arbetsytan (`media/inbound/*`).
Skills‑notering: verktyget `read` är sandbox‑rotat. Med `workspaceAccess: "none"`
speglar OpenClaw berättigade Skills till sandbox‑arbetsytan (`.../skills`) så
att de kan läsas. Med `"rw"` är workspace‑Skills läsbara från
`/workspace/skills`.

## Anpassade bind‑mounts

`agents.defaults.sandbox.docker.binds` monterar ytterligare värdkataloger i containern.
Format: `host:container:mode` (t.ex. `"/home/user/source:/source:rw"`).

Globala och per‑agent‑bindningar **slås samman** (ersätts inte). Under `scope: "shared"` ignoreras per‑agent‑bindningar.

Exempel (skrivskyddad källa + docker‑socket):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

Säkerhetsnoteringar:

- Bindningar kringgår sandboxens filsystem: de exponerar värdvägar med det läge du anger (`:ro` eller `:rw`).
- Känsliga monteringar (t.ex. `docker.sock`, hemligheter, SSH‑nycklar) bör vara `:ro` om de inte är absolut nödvändiga.
- Kombinera med `workspaceAccess: "ro"` om du bara behöver läsåtkomst till arbetsytan; bind‑lägen förblir oberoende.
- Se [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) för hur bindningar samverkar med verktygspolicy och förhöjd exec.

## Images + konfigurering

Standard‑image: `openclaw-sandbox:bookworm-slim`

Bygg den en gång:

```bash
scripts/sandbox-setup.sh
```

Obs: standard‑imagen innehåller **inte** Node. Om en Skill behöver Node (eller
andra runtime‑miljöer), baka antingen en anpassad image eller installera via
`sandbox.docker.setupCommand` (kräver nätverksutgående trafik + skrivbar rot +
root‑användare).

Image för sandlådad webbläsare:

```bash
scripts/sandbox-browser-setup.sh
```

Som standard körs sandbox‑containrar **utan nätverk**.
Åsidosätt med `agents.defaults.sandbox.docker.network`.

Docker‑installationer och den containeriserade Gateway finns här:
[Docker](/install/docker)

## setupCommand (engångs‑containerkonfigurering)

`setupCommand` körs **en gång** efter att sandbox‑containern har skapats (inte vid varje körning).
Det exekveras inuti containern via `sh -lc`.

Sökvägar:

- Globalt: `agents.defaults.sandbox.docker.setupCommand`
- Per‑agent: `agents.list[].sandbox.docker.setupCommand`

Vanliga fallgropar:

- Standard för `docker.network` är `"none"` (ingen egress), så paketinstallationer misslyckas.
- `readOnlyRoot: true` förhindrar skrivningar; sätt `readOnlyRoot: false` eller baka en anpassad image.
- `user` måste vara root för paketinstallationer (utelämna `user` eller sätt `user: "0:0"`).
- Sandbox‑exec ärver **inte** värdens `process.env`. Använd
  `agents.defaults.sandbox.docker.env` (eller en anpassad image) för Skill‑API‑nycklar.

## Verktygspolicy + nödutgångar

Tillåt-/nek‑policyer för verktyg gäller fortfarande före sandbox‑regler. Om ett verktyg är nekat
globalt eller per‑agent, tar sandboxing inte tillbaka det.

`tools.elevated` är en uttrycklig nödutgång som kör `exec` på värden.
Direktiv i `/exec` gäller endast för auktoriserade avsändare och kvarstår per session; för att hård‑inaktivera
`exec`, använd verktygspolicy‑nek (se [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Felsökning:

- Använd `openclaw sandbox explain` för att inspektera effektivt sandbox‑läge, verktygspolicy och fix‑it‑konfignycklar.
- Se [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) för den mentala modellen ”varför blockeras detta?”.
  Håll det låst.

## Multi‑agent‑åsidosättningar

Varje agent kan åsidosätta sandbox + verktyg:
`agents.list[].sandbox` och `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools` för sandbox‑verktygspolicy).
Se [Multi‑Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) för prioritet.

## Minimalt aktiverings‑exempel

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Relaterad dokumentation

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi‑Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
