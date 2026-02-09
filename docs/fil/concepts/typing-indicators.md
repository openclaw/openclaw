---
summary: "Kailan nagpapakita ang OpenClaw ng mga indikator ng pagta-type at kung paano i-tune ang mga ito"
read_when:
  - Binabago ang behavior o mga default ng typing indicator
title: "Mga Indikador ng Pagta-type"
---

# Mga indikator ng pagta-type

Typing indicators are sent to the chat channel while a run is active. Use
`agents.defaults.typingMode` to control **when** typing starts and `typingIntervalSeconds`
to control **how often** it refreshes.

## Mga default

Kapag **hindi naka-set** ang `agents.defaults.typingMode`, pinananatili ng OpenClaw ang legacy na behavior:

- **Mga direct chat**: nagsisimula agad ang pagta-type kapag nagsimula ang model loop.
- **Mga group chat na may mention**: nagsisimula agad ang pagta-type.
- **Mga group chat na walang mention**: nagsisimula lang ang pagta-type kapag nagsimulang mag-stream ang text ng mensahe.
- **Mga heartbeat run**: naka-disable ang pagta-type.

## Mga mode

I-set ang `agents.defaults.typingMode` sa isa sa:

- `never` — walang typing indicator, kailanman.
- `instant` — magsimula ang pagta-type **sa sandaling magsimula ang model loop**, kahit na ang run ay
  magbalik lang kalaunan ng silent reply token.
- `thinking` — magsimula ang pagta-type sa **unang reasoning delta** (nangangailangan ng
  `reasoningLevel: "stream"` para sa run).
- `message` — magsimula ang pagta-type sa **unang non-silent na text delta** (ini-ignore
  ang `NO_REPLY` na silent token).

Pagkakasunod-sunod ng “kung gaano kaaga ito nagfa-fire”:
`never` → `message` → `thinking` → `instant`

## Konpigurasyon

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

Maaari mong i-override ang mode o cadence kada session:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Mga tala

- Ang `message` mode ay hindi magpapakita ng pagta-type para sa mga silent-only na reply (hal. ang `NO_REPLY`
  token na ginagamit para pigilan ang output).
- `thinking` only fires if the run streams reasoning (`reasoningLevel: "stream"`).
  If the model doesn’t emit reasoning deltas, typing won’t start.
- Ang mga heartbeat ay hindi kailanman nagpapakita ng pagta-type, anuman ang mode.
- `typingIntervalSeconds` controls the **refresh cadence**, not the start time.
  The default is 6 seconds.
