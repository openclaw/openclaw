---
summary: "Como áudios/notas de voz de entrada são baixados, transcritos e injetados nas respostas"
read_when:
  - Ao alterar a transcrição de áudio ou o tratamento de mídia
title: "Áudio e Notas de Voz"
---

# Áudio / Notas de Voz — 2026-01-17

## O que funciona

- **Compreensão de mídia (áudio)**: Se a compreensão de áudio estiver habilitada (ou detectada automaticamente), o OpenClaw:
  1. Localiza o primeiro anexo de áudio (caminho local ou URL) e faz o download se necessário.
  2. Aplica `maxBytes` antes de enviar para cada entrada de modelo.
  3. Executa a primeira entrada de modelo elegível em ordem (provedor ou CLI).
  4. Se falhar ou pular (tamanho/timeout), tenta a próxima entrada.
  5. Em caso de sucesso, substitui `Body` por um bloco `[Audio]` e define `{{Transcript}}`.
- **Análise de comandos**: Quando a transcrição é bem-sucedida, `CommandBody`/`RawBody` são definidos como a transcrição para que os comandos de barra continuem funcionando.
- **Logs detalhados**: Em `--verbose`, registramos quando a transcrição é executada e quando ela substitui o corpo.

## Detecção automática (padrão)

Se você **não configurar modelos** e `tools.media.audio.enabled` **não** estiver definido como `false`,
o OpenClaw faz a detecção automática nesta ordem e para na primeira opção que funcionar:

1. **CLIs locais** (se instaladas)
   - `sherpa-onnx-offline` (requer `SHERPA_ONNX_MODEL_DIR` com encoder/decoder/joiner/tokens)
   - `whisper-cli` (de `whisper-cpp`; usa `WHISPER_CPP_MODEL` ou o modelo tiny incluído)
   - `whisper` (CLI em Python; baixa os modelos automaticamente)
2. **Gemini CLI** (`gemini`) usando `read_many_files`
3. **Chaves de provedor** (OpenAI → Groq → Deepgram → Google)

Para desativar a detecção automática, defina `tools.media.audio.enabled: false`.
Para personalizar, defina `tools.media.audio.models`.
Nota: A detecção de binários é best-effort em macOS/Linux/Windows; garanta que a CLI esteja em `PATH` (expandimos `~`), ou defina um modelo de CLI explícito com o caminho completo do comando.

## Exemplos de configuração

### Provedor + fallback de CLI (OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### Somente provedor com controle por escopo

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### Somente provedor (Deepgram)

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

## Notas e limites

- A autenticação do provedor segue a ordem padrão de autenticação do modelo (perfis de autenticação, variáveis de ambiente, `models.providers.*.apiKey`).
- O Deepgram usa `DEEPGRAM_API_KEY` quando `provider: "deepgram"` é utilizado.
- Detalhes de configuração do Deepgram: [Deepgram (transcrição de áudio)](/providers/deepgram).
- Provedores de áudio podem sobrescrever `baseUrl`, `headers` e `providerOptions` via `tools.media.audio`.
- O limite de tamanho padrão é 20MB (`tools.media.audio.maxBytes`). Áudio acima do tamanho é ignorado para aquele modelo e a próxima entrada é tentada.
- O `maxChars` padrão para áudio é **não definido** (transcrição completa). Defina `tools.media.audio.maxChars` ou `maxChars` por entrada para reduzir a saída.
- O padrão automático da OpenAI é `gpt-4o-mini-transcribe`; defina `model: "gpt-4o-transcribe"` para maior precisão.
- Use `tools.media.audio.attachments` para processar várias notas de voz (`mode: "all"` + `maxAttachments`).
- A transcrição fica disponível para templates como `{{Transcript}}`.
- A saída stdout da CLI é limitada (5MB); mantenha a saída da CLI concisa.

## Pegadas

- As regras de escopo usam “primeira correspondência vence”. `chatType` é normalizado para `direct`, `group` ou `room`.
- Garanta que sua CLI finalize com código 0 e imprima texto simples; JSON precisa ser ajustado via `jq -r .text`.
- Mantenha timeouts razoáveis (`timeoutSeconds`, padrão 60s) para evitar bloquear a fila de respostas.
