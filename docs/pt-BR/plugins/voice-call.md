---
summary: "Plugin de Chamada de Voz: chamadas de saída + entrada via Twilio/Telnyx/Plivo (instalação do plugin + configuração + CLI)"
read_when:
  - Você quer fazer uma chamada de voz de saída a partir do OpenClaw
  - Você está configurando ou desenvolvendo o plugin de voice-call
title: "Plugin de Chamada de Voz"
---

# Chamada de Voz (plugin)

Chamadas de voz para o OpenClaw por meio de um plugin. Suporta notificações de saída e
conversas de múltiplos turnos com políticas de entrada.

Provedores atuais:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + transferência XML + fala GetInput)
- `mock` (dev/sem rede)

Modelo mental rápido:

- Instale o plugin
- Reinicie o Gateway
- Configure em `plugins.entries.voice-call.config`
- Use `openclaw voicecall ...` ou a ferramenta `voice_call`

## Onde ele roda (local vs remoto)

O plugin de Chamada de Voz roda **dentro do processo do Gateway**.

Se você usar um Gateway remoto, instale/configure o plugin na **máquina que executa o Gateway**, depois reinicie o Gateway para carregá-lo.

## Instalação

### Opção A: instalar a partir do npm (recomendado)

```bash
openclaw plugins install @openclaw/voice-call
```

Reinicie o Gateway depois.

### Opção B: instalar a partir de uma pasta local (dev, sem cópia)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

Reinicie o Gateway depois.

## Configuração

Defina a configuração em `plugins.entries.voice-call.config`:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // or "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook server
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook security (recommended for tunnels/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Public exposure (pick one)
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", path: "/voice/webhook" }

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: {
            enabled: true,
            streamPath: "/voice/stream",
          },
        },
      },
    },
  },
}
```

Notas:

- Twilio/Telnyx exigem uma URL de webhook **publicamente acessível**.
- Plivo exige uma URL de webhook **publicamente acessível**.
- `mock` é um provedor local de dev (sem chamadas de rede).
- `skipSignatureVerification` é apenas para testes locais.
- Se você usar o plano gratuito do ngrok, defina `publicUrl` para a URL exata do ngrok; a verificação de assinatura é sempre aplicada.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` permite webhooks do Twilio com assinaturas inválidas **somente** quando `tunnel.provider="ngrok"` e `serve.bind` é loopback (agente local do ngrok). Use apenas para dev local.
- URLs do plano gratuito do ngrok podem mudar ou adicionar comportamento intermediário; se `publicUrl` variar, as assinaturas do Twilio falharão. Para produção, prefira um domínio estável ou um funnel do Tailscale.

## Segurança de Webhook

Quando um proxy ou túnel fica na frente do Gateway, o plugin reconstrói a
URL pública para verificação de assinatura. Essas opções controlam quais
headers encaminhados são confiáveis.

`webhookSecurity.allowedHosts` cria uma lista de permissões de hosts a partir dos headers de encaminhamento.

`webhookSecurity.trustForwardingHeaders` confia nos headers encaminhados sem uma lista de permissões.

`webhookSecurity.trustedProxyIPs` só confia nos headers encaminhados quando o IP remoto da requisição
corresponde à lista.

Exemplo com um host público estável:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          publicUrl: "https://voice.example.com/voice/webhook",
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
          },
        },
      },
    },
  },
}
```

## TTS para chamadas

Chamada de Voz usa a configuração principal de `messages.tts` (OpenAI ou ElevenLabs) para
streaming de fala nas chamadas. Você pode sobrescrevê-la na configuração do plugin com o
**mesmo formato** — ela é mesclada em profundidade com `messages.tts`.

```json5
{
  tts: {
    provider: "elevenlabs",
    elevenlabs: {
      voiceId: "pMsXgVXv3BLzUgSXRplE",
      modelId: "eleven_multilingual_v2",
    },
  },
}
```

Notas:

- **O Edge TTS é ignorado para chamadas de voz** (o áudio de telefonia precisa de PCM; a saída do Edge é pouco confiável).
- O TTS principal é usado quando o streaming de mídia do Twilio está habilitado; caso contrário, as chamadas recorrem às vozes nativas do provedor.

### Mais exemplos

Usar apenas o TTS principal (sem sobrescrever):

```json5
{
  messages: {
    tts: {
      provider: "openai",
      openai: { voice: "alloy" },
    },
  },
}
```

Sobrescrever para ElevenLabs apenas para chamadas (manter o padrão principal em outros lugares):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "elevenlabs",
            elevenlabs: {
              apiKey: "elevenlabs_key",
              voiceId: "pMsXgVXv3BLzUgSXRplE",
              modelId: "eleven_multilingual_v2",
            },
          },
        },
      },
    },
  },
}
```

Sobrescrever apenas o modelo OpenAI para chamadas (exemplo de mesclagem profunda):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            openai: {
              model: "gpt-4o-mini-tts",
              voice: "marin",
            },
          },
        },
      },
    },
  },
}
```

## Chamadas de entrada

A política de entrada padrão é `disabled`. Para habilitar chamadas de entrada, defina:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

As respostas automáticas usam o sistema de agentes. Ajuste com:

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## Ferramenta de agente

Nome da ferramenta: `voice_call`

Ações:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Este repositório inclui um documento de skill correspondente em `skills/voice-call/SKILL.md`.

## RPC do Gateway

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
