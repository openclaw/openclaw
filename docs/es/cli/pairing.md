---
summary: "Referencia de la CLI para `openclaw pairing` (aprobar/listar solicitudes de emparejamiento)"
read_when:
  - Está usando mensajes directos en modo de emparejamiento y necesita aprobar remitentes
title: "emparejamiento"
x-i18n:
  source_path: cli/pairing.md
  source_hash: 785869d24d953141
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:55Z
---

# `openclaw pairing`

Apruebe o inspeccione solicitudes de emparejamiento de mensajes directos (para canales que admiten emparejamiento).

Relacionado:

- Flujo de emparejamiento: [Emparejamiento](/channels/pairing)

## Comandos

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code> --notify
```
