---
summary: "Hur OpenClaw sandboxing fungerar: lägen, omfång, åtkomst till arbetsyta och images"
title: Sandboxing
read_when: "Du vill ha en dedikerad förklaring av sandboxing eller behöver justera agents.defaults.sandbox."
status: active
---

# Sandboxing

OpenClaw kan köra **verktyg inuti Docker-behållare** för att minska sprängradie.
Detta är **valfritt** och styrs av konfigurationen (`agents.defaults.sandbox` eller
`agents.list[].sandbox`). Om sandlådan är avstängd körs verktygen på värden.
Gateway stannar på värden; verktygskörning körs i en isolerad sandlåda
när aktiverad.

Detta är inte en perfekt säkerhetsgräns, men den begränsar i praktiken åtkomst till
filsystem och processer när modellen gör något dumt.

## Vad som sandlådas

- Verktygskörning (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, etc.).
- Valfri sandlådad webbläsare (`agents.defaults.sandbox.browser`).
  - Som standard startar sandbox-webbläsaren automatiskt (säkerställer att CDP är nåbar) när webbläsarverktyget behöver det.
    Konfigurera via `agents.defaults.sandbox.browser.autoStart` och `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` låter sandlådade sessioner explicit rikta sig mot värdens webbläsare.
  - Valfria tillåtelselistor styr `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Inte sandlådat:

- Själva Gateway‑processen.
- Alla verktyg som uttryckligen tillåts köras på värden (t.ex. `tools.elevated`).
  - **Förhöjd exec körs på värden och kringgår sandboxing.**
  - Om sandboxning är avstängd, ändrar `tools.elevated` inte exekvering (redan på värd). Se [Elevated Mode](/tools/elevated).

## Lägen

`agents.defaults.sandbox.mode` styr **när** sandboxing används:

- `"off"`: ingen sandboxing.
- `"non-main"`: sandlåda endast **icke‑huvud**‑sessioner (standard om du vill ha normala chattar på värden).
- `"alla"`: varje session körs i en sandlåda.
  Obs: `"non-main"` är baserad på `session.mainKey` (standard `"main"`), inte agent-id.
  Grupp/kanalsessioner använder sina egna nycklar, så de räknas som icke-huvud och kommer att sandlåda.

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

Inkommande media kopieras till den aktiva sandlådans arbetsyta (`media/inbound/*`).
Färdighetskommentaren: verktyget `read` är sandlåda-rotat. Med `workspaceAccess: "none"`,
OpenClaw speglar kvalificerade färdigheter i sandlådans arbetsyta (`.../skills`) så att
de kan läsas. Med `"rw"`, är arbetsytans färdigheter läsbara från
`/workspace/skills`.

## Anpassade bind‑mounts

`agents.defaults.sandbox.docker.binds` monterar ytterligare värdkataloger i behållaren.
Format: `host:container:mode` (t.ex., `"/home/user/source:/source:rw"`).

Globala bindningar och per-agent är **sammanslagna** (ersättare). Under `scope: "shared"`, bindningar per agent ignoreras.

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
- Känsliga fästen (t.ex., `docker.sock`, hemligheter, SSH-nycklar) bör vara `:ro` om det inte absolut krävs.
- Kombinera med `workspaceAccess: "ro"` om du bara behöver läsåtkomst till arbetsytan; bind‑lägen förblir oberoende.
- Se [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) för hur bindningar samverkar med verktygspolicy och förhöjd exec.

## Images + konfigurering

Standard‑image: `openclaw-sandbox:bookworm-slim`

Bygg den en gång:

```bash
scripts/sandbox-setup.sh
```

Notera: Standardbilden innehåller **inte** nod. Om en färdighet behöver Node (eller
andra körtider), antingen baka en anpassad bild eller installera via
`sandbox. ocker.setupCommand` (kräver nätverks egress + skrivbar rot +
root-användare).

Image för sandlådad webbläsare:

```bash
scripts/sandbox-browser-setup.sh
```

Som standard körs sandlådbehållare med **inget nätverk**.
Åsidosätt med `agents.defaults.sandbox.docker.network`.

Docker‑installationer och den containeriserade Gateway finns här:
[Docker](/install/docker)

## setupCommand (engångs‑containerkonfigurering)

`setupCommand` körs **en gång** efter att sandlådan har skapats (inte på varje körning).
Den körs inuti behållaren via `sh -lc`.

Sökvägar:

- Globalt: `agents.defaults.sandbox.docker.setupCommand`
- Per‑agent: `agents.list[].sandbox.docker.setupCommand`

Vanliga fallgropar:

- Standard för `docker.network` är `"none"` (ingen egress), så paketinstallationer misslyckas.
- `readOnlyRoot: true` förhindrar skrivningar; sätt `readOnlyRoot: false` eller baka en anpassad image.
- `user` måste vara root för paketinstallationer (utelämna `user` eller sätt `user: "0:0"`).
- Sandbox exec ärver **inte** värden `process.env`. Använd
  `agents.defaults.sandbox.docker.env` (eller en anpassad bild) för skicklighetsAPI-nycklar.

## Verktygspolicy + nödutgångar

Verktyget tillåter/neka policyer fortfarande gäller före sandlådans regler. Om ett verktyg nekas
globalt eller per agent, sandlådan inte föra den tillbaka.

`tools.elevated` är en explicit escape-lucka som kör `exec` på värden.
`/exec` direktiv gäller endast för auktoriserade avsändare och kvarstår per session; för att hard-disable
`exec`, använd verktygspolicy neka (se [Sandbox vs Verktygspolicy vs förhöjd](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Felsökning:

- Använd `openclaw sandbox explain` för att inspektera effektivt sandbox‑läge, verktygspolicy och fix‑it‑konfignycklar.
- Se [Sandbox vs Verktygspolicy vs förhöjd](/gateway/sandbox-vs-tool-policy-vs-elevated) för “varför är detta blockerad?” mental modell.
  Håll den låst.

## Multi‑agent‑åsidosättningar

Varje agent kan åsidosätta sandlåda + verktyg:
`agents.list[].sandbox` och `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools` för politik för sandboxverktyg).
Se [Multi-Agent Sandbox & Verktyg](/tools/multi-agent-sandbox-tools) för företräde.

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
