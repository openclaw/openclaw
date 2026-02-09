---
summary: "Transcrição do Deepgram para notas de voz de entrada"
read_when:
  - Você quer speech-to-text do Deepgram para anexos de áudio
  - Você precisa de um exemplo rápido de configuração do Deepgram
title: "Deepgram"
---

# Deepgram (Transcrição de Áudio)

Deepgram é uma API de speech-to-text. No OpenClaw, ela é usada para **transcrição de áudio/notas de voz de entrada**
via `tools.media.audio`.

Quando ativado, o OpenClaw envia o arquivo de áudio para o Deepgram e injeta a transcrição
no pipeline de resposta (`{{Transcript}}` + bloco `[Audio]`). Isso **não é streaming**;
usa o endpoint de transcrição pré-gravada.

Website: [https://deepgram.com](https://deepgram.com)  
Docs: [https://developers.deepgram.com](https://developers.deepgram.com)

## Início Rápido

1. Defina sua chave de API:

```
DEEPGRAM_API_KEY=dg_...
```

2. Ative o provedor:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Opções

- `model`: ID do modelo do Deepgram (padrão: `nova-3`)
- `language`: dica de idioma (opcional)
- `tools.media.audio.providerOptions.deepgram.detect_language`: ativar detecção de idioma (opcional)
- `tools.media.audio.providerOptions.deepgram.punctuate`: ativar pontuação (opcional)
- `tools.media.audio.providerOptions.deepgram.smart_format`: ativar formatação inteligente (opcional)

Exemplo com idioma:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

Exemplo com opções do Deepgram:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Notas

- A autenticação segue a ordem padrão de autenticação de provedores; `DEEPGRAM_API_KEY` é o caminho mais simples.
- Substitua endpoints ou cabeçalhos com `tools.media.audio.baseUrl` e `tools.media.audio.headers` ao usar um proxy.
- A saída segue as mesmas regras de áudio que outros provedores (limites de tamanho, timeouts, injeção da transcrição).
