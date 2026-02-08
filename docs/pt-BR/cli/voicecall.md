---
summary: "Referência da CLI para `openclaw voicecall` (superfície de comandos do plugin de chamadas de voz)"
read_when:
  - Você usa o plugin de chamadas de voz e quer os pontos de entrada da CLI
  - Você quer exemplos rápidos para `voicecall call|continue|status|tail|expose`
title: "voicecall"
x-i18n:
  source_path: cli/voicecall.md
  source_hash: d93aaee6f6f5c9ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:30Z
---

# `openclaw voicecall`

`voicecall` é um comando fornecido por plugin. Ele só aparece se o plugin voice-call estiver instalado e habilitado.

Documento principal:

- Plugin voice-call: [Voice Call](/plugins/voice-call)

## Comandos comuns

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## Expondo webhooks (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

Nota de segurança: exponha o endpoint de webhook apenas para redes em que você confia. Prefira o Tailscale Serve ao Funnel quando possível.
