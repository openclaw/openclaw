---
summary: "Modo Talk: conversas de fala contínuas com TTS da ElevenLabs"
read_when:
  - Implementando o modo Talk no macOS/iOS/Android
  - Alterando comportamento de voz/TTS/interrupção
title: "Modo Talk"
---

# Modo Talk

O modo Talk é um loop contínuo de conversa por voz:

1. Ouvir a fala
2. Enviar a transcrição para o modelo (sessão principal, chat.send)
3. Aguardar a resposta
4. Falar via ElevenLabs (reprodução por streaming)

## Comportamento (macOS)

- **Overlay sempre ativo** enquanto o modo Talk estiver habilitado.
- Transições de fase **Ouvindo → Pensando → Falando**.
- Em uma **pausa curta** (janela de silêncio), a transcrição atual é enviada.
- As respostas são **escritas no WebChat** (igual a digitar).
- **Interromper ao falar** (ativado por padrão): se o usuário começar a falar enquanto o assistente está falando, a reprodução é interrompida e o timestamp da interrupção é anotado para o próximo prompt.

## Diretivas de voz nas respostas

O assistente pode prefixar sua resposta com **uma única linha JSON** para controlar a voz:

```json
{ "voice": "<voice-id>", "once": true }
```

Regras:

- Apenas a primeira linha não vazia.
- Chaves desconhecidas são ignoradas.
- `once: true` se aplica apenas à resposta atual.
- Sem `once`, a voz passa a ser o novo padrão do modo Talk.
- A linha JSON é removida antes da reprodução TTS.

Chaves suportadas:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Configuração (`~/.openclaw/openclaw.json`)

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

Padrões:

- `interruptOnSpeech`: true
- `voiceId`: retorna para `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (ou a primeira voz da ElevenLabs quando a chave de API estiver disponível)
- `modelId`: assume `eleven_v3` quando não definido
- `apiKey`: retorna para `ELEVENLABS_API_KEY` (ou o perfil de shell do gateway, se disponível)
- `outputFormat`: assume `pcm_44100` no macOS/iOS e `pcm_24000` no Android (defina `mp3_*` para forçar streaming MP3)

## UI do macOS

- Alternador na barra de menu: **Talk**
- Aba de configuração: grupo **Modo Talk** (ID da voz + alternador de interrupção)
- Overlay:
  - **Ouvindo**: nuvem pulsa com o nível do microfone
  - **Pensando**: animação de afundamento
  - **Falando**: anéis irradiantes
  - Clique na nuvem: parar de falar
  - Clique no X: sair do modo Talk

## Notas

- Requer permissões de Fala + Microfone.
- Usa `chat.send` com a chave de sessão `main`.
- O TTS usa a API de streaming da ElevenLabs com `ELEVENLABS_API_KEY` e reprodução incremental no macOS/iOS/Android para menor latência.
- `stability` para `eleven_v3` é validado como `0.0`, `0.5` ou `1.0`; outros modelos aceitam `0..1`.
- `latency_tier` é validado como `0..4` quando definido.
- O Android oferece suporte aos formatos de saída `pcm_16000`, `pcm_22050`, `pcm_24000` e `pcm_44100` para streaming AudioTrack de baixa latência.
