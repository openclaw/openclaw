---
summary: "Tlon/Urbit‑Unterstützungsstatus, Fähigkeiten und Konfiguration"
read_when:
  - Arbeiten an Tlon/Urbit‑Kanalfunktionen
title: "Tlon"
---

# Tlon (Plugin)

Tlon ist ein dezentraler Messenger, der auf Urbit basiert. OpenClaw verbindet sich mit Ihrem Urbit‑Ship und kann auf Direktnachrichten sowie Gruppenchat‑Nachrichten reagieren. Gruppenantworten erfordern standardmäßig eine @‑Erwähnung und können zusätzlich über Allowlists eingeschränkt werden.

Status: unterstützt über Plugin. Direktnachrichten, Gruppenerwähnungen, Thread‑Antworten und textbasierter Medien‑Fallback (URL an die Beschriftung angehängt). Reaktionen, Umfragen und native Medien‑Uploads werden nicht unterstützt.

## Plugin erforderlich

Tlon wird als Plugin bereitgestellt und ist nicht im Core‑Installationspaket enthalten.

Installation über die CLI (npm‑Registry):

```bash
openclaw plugins install @openclaw/tlon
```

Lokaler Checkout (bei Ausführung aus einem Git‑Repository):

```bash
openclaw plugins install ./extensions/tlon
```

Details: [Plugins](/tools/plugin)

## Setup

1. Installieren Sie das Tlon‑Plugin.
2. Erfassen Sie Ihre Ship‑URL und den Login‑Code.
3. Konfigurieren Sie `channels.tlon`.
4. Starten Sie das Gateway neu.
5. Senden Sie dem Bot eine Direktnachricht oder erwähnen Sie ihn in einem Gruppenkanal.

Minimale Konfiguration (einzelnes Konto):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## Gruppenkanäle

Auto‑Discovery ist standardmäßig aktiviert. Sie können Kanäle auch manuell anheften:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Auto‑Discovery deaktivieren:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Zugriffskontrolle

DM‑Allowlist (leer = alle erlauben):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Gruppenautorisierung (standardmäßig eingeschränkt):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Zustellungsziele (CLI/Cron)

Verwenden Sie diese mit `openclaw message send` oder für die Zustellung per Cron:

- DM: `~sampel-palnet` oder `dm/~sampel-palnet`
- Gruppe: `chat/~host-ship/channel` oder `group:~host-ship/channel`

## Hinweise

- Gruppenantworten erfordern eine Erwähnung (z. B. `~your-bot-ship`), um zu antworten.
- Thread‑Antworten: Befindet sich die eingehende Nachricht in einem Thread, antwortet OpenClaw im Thread.
- Medien: `sendMedia` fällt auf Text + URL zurück (kein nativer Upload).
