---
summary: "„Stellen Sie einen OpenAI‑kompatiblen /v1/chat/completions‑HTTP‑Endpunkt über das Gateway bereit“"
read_when:
  - Integration von Werkzeugen, die OpenAI Chat Completions erwarten
title: "„OpenAI Chat Completions“"
---

# OpenAI Chat Completions (HTTP)

Das Gateway von OpenClaw kann einen kleinen OpenAI‑kompatiblen Chat‑Completions‑Endpunkt bereitstellen.

Dieser Endpunkt ist **standardmäßig deaktiviert**. Aktivieren Sie ihn zuerst in der Konfiguration.

- `POST /v1/chat/completions`
- Gleicher Port wie das Gateway (WS + HTTP‑Multiplex): `http://<gateway-host>:<port>/v1/chat/completions`

Unter der Haube werden Anfragen als normaler Gateway‑Agent‑Lauf ausgeführt (gleicher Codepfad wie `openclaw agent`), sodass Routing/Berechtigungen/Konfiguration Ihrem Gateway entsprechen.

## Authentifizierung

Verwendet die Gateway‑Authentifizierungskonfiguration. Senden Sie ein Bearer‑Token:

- `Authorization: Bearer <token>`

Hinweise:

- Wenn `gateway.auth.mode="token"`, verwenden Sie `gateway.auth.token` (oder `OPENCLAW_GATEWAY_TOKEN`).
- Wenn `gateway.auth.mode="password"`, verwenden Sie `gateway.auth.password` (oder `OPENCLAW_GATEWAY_PASSWORD`).

## Auswahl eines Agenten

Keine benutzerdefinierten Header erforderlich: Kodieren Sie die Agent‑ID im OpenAI‑Feld `model`:

- `model: "openclaw:<agentId>"` (Beispiel: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (Alias)

Oder sprechen Sie einen bestimmten OpenClaw‑Agenten per Header an:

- `x-openclaw-agent-id: <agentId>` (Standard: `main`)

Erweitert:

- `x-openclaw-session-key: <sessionKey>` zur vollständigen Kontrolle des Sitzungs‑Routings.

## Aktivieren des Endpunkts

Setzen Sie `gateway.http.endpoints.chatCompletions.enabled` auf `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## Deaktivieren des Endpunkts

Setzen Sie `gateway.http.endpoints.chatCompletions.enabled` auf `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## Sitzungsverhalten

Standardmäßig ist der Endpunkt **zustandslos pro Anfrage** (bei jedem Aufruf wird ein neuer Sitzungsschlüssel generiert).

Wenn die Anfrage eine OpenAI‑Zeichenkette `user` enthält, leitet das Gateway daraus einen stabilen Sitzungsschlüssel ab, sodass wiederholte Aufrufe eine Agent‑Sitzung teilen können.

## Streaming (SSE)

Setzen Sie `stream: true`, um Server‑Sent Events (SSE) zu erhalten:

- `Content-Type: text/event-stream`
- Jede Ereigniszeile ist `data: <json>`
- Der Stream endet mit `data: [DONE]`

## Beispiele

Nicht‑Streaming:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
