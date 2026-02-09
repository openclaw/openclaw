---
summary: "Compreensão de imagem/áudio/vídeo de entrada (opcional) com provedor + fallbacks via CLI"
read_when:
  - Projetando ou refatorando a compreensão de mídia
  - Ajustando o pré-processamento de áudio/vídeo/imagem de entrada
title: "Compreensão de Mídia"
---

# Compreensão de Mídia (Entrada) — 2026-01-17

O OpenClaw pode **resumir mídia de entrada** (imagem/áudio/vídeo) antes da execução do pipeline de resposta. Ele detecta automaticamente quando ferramentas locais ou chaves de provedor estão disponíveis e pode ser desativado ou personalizado. Se a compreensão estiver desativada, os modelos ainda recebem os arquivos/URLs originais normalmente.

## Objetivos

- Opcional: pré-digerir a mídia de entrada em texto curto para roteamento mais rápido + melhor análise de comandos.
- Preservar sempre a entrega da mídia original ao modelo.
- Suportar **APIs de provedores** e **fallbacks via CLI**.
- Permitir múltiplos modelos com fallback ordenado (erro/tamanho/timeout).

## Comportamento em alto nível

1. Coletar anexos de entrada (`MediaPaths`, `MediaUrls`, `MediaTypes`).
2. Para cada capacidade habilitada (imagem/áudio/vídeo), selecionar anexos conforme a política (padrão: **primeiro**).
3. Escolher a primeira entrada de modelo elegível (tamanho + capacidade + autenticação).
4. Se um modelo falhar ou a mídia for grande demais, **fazer fallback para a próxima entrada**.
5. Em caso de sucesso:
   - `Body` torna-se um bloco `[Image]`, `[Audio]` ou `[Video]`.
   - Áudio define `{{Transcript}}`; a análise de comandos usa o texto da legenda quando presente,
     caso contrário, a transcrição.
   - As legendas são preservadas como `User text:` dentro do bloco.

Se a compreensão falhar ou estiver desativada, **o fluxo de resposta continua** com o corpo original + anexos.

## Visão geral de configuração

`tools.media` suporta **modelos compartilhados** além de substituições por capacidade:

- `tools.media.models`: lista de modelos compartilhados (use `capabilities` para controlar).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - padrões (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - substituições por provedor (`baseUrl`, `headers`, `providerOptions`)
  - opções de áudio Deepgram via `tools.media.audio.providerOptions.deepgram`
  - **lista opcional por capacidade `models`** (preferida antes dos modelos compartilhados)
  - política `attachments` (`mode`, `maxAttachments`, `prefer`)
  - `scope` (controle opcional por canal/chatType/chave de sessão)
- `tools.media.concurrency`: máximo de execuções concorrentes por capacidade (padrão **2**).

```json5
{
  tools: {
    media: {
      models: [
        /* shared list */
      ],
      image: {
        /* optional overrides */
      },
      audio: {
        /* optional overrides */
      },
      video: {
        /* optional overrides */
      },
    },
  },
}
```

### Entradas de modelo

Cada entrada `models[]` pode ser de **provedor** ou **CLI**:

```json5
{
  type: "provider", // default if omitted
  provider: "openai",
  model: "gpt-5.2",
  prompt: "Describe the image in <= 500 chars.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // optional, used for multi‑modal entries
  profile: "vision-profile",
  preferredProfile: "vision-fallback",
}
```

```json5
{
  type: "cli",
  command: "gemini",
  args: [
    "-m",
    "gemini-3-flash",
    "--allowed-tools",
    "read_file",
    "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
  ],
  maxChars: 500,
  maxBytes: 52428800,
  timeoutSeconds: 120,
  capabilities: ["video", "image"],
}
```

Os templates de CLI também podem usar:

- `{{MediaDir}}` (diretório que contém o arquivo de mídia)
- `{{OutputDir}}` (diretório temporário criado para esta execução)
- `{{OutputBase}}` (caminho base do arquivo temporário, sem extensão)

## Padrões e limites

Padrões recomendados:

- `maxChars`: **500** para imagem/vídeo (curto, amigável a comandos)
- `maxChars`: **não definido** para áudio (transcrição completa, a menos que você defina um limite)
- `maxBytes`:
  - imagem: **10MB**
  - áudio: **20MB**
  - vídeo: **50MB**

Regras:

- Se a mídia exceder `maxBytes`, esse modelo é ignorado e o **próximo modelo é tentado**.
- Se o modelo retornar mais do que `maxChars`, a saída é truncada.
- `prompt` usa por padrão um simples “Describe the {media}.” mais a orientação `maxChars` (apenas imagem/vídeo).
- Se `<capability>.enabled: true` mas nenhum modelo estiver configurado, o OpenClaw tenta o
  **modelo de resposta ativo** quando o provedor dele suporta a capacidade.

### Detecção automática de compreensão de mídia (padrão)

Se `tools.media.<capability>.enabled` **não** estiver definido como `false` e você não tiver
configurado modelos, o OpenClaw detecta automaticamente nesta ordem e **para na primeira
opção funcional**:

1. **CLIs locais** (apenas áudio; se instaladas)
   - `sherpa-onnx-offline` (requer `SHERPA_ONNX_MODEL_DIR` com encoder/decoder/joiner/tokens)
   - `whisper-cli` (`whisper-cpp`; usa `WHISPER_CPP_MODEL` ou o modelo tiny incluído)
   - `whisper` (CLI Python; baixa modelos automaticamente)
2. **Gemini CLI** (`gemini`) usando `read_many_files`
3. **Chaves de provedor**
   - Áudio: OpenAI → Groq → Deepgram → Google
   - Imagem: OpenAI → Anthropic → Google → MiniMax
   - Vídeo: Google

Para desativar a detecção automática, defina:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: false,
      },
    },
  },
}
```

Nota: A detecção de binários é best-effort em macOS/Linux/Windows; garanta que a CLI esteja em `PATH` (expandimos `~`), ou defina um modelo de CLI explícito com o caminho completo do comando.

## Capacidades (opcional)

Se você definir `capabilities`, a entrada só é executada para esses tipos de mídia. Para listas
compartilhadas, o OpenClaw pode inferir padrões:

- `openai`, `anthropic`, `minimax`: **imagem**
- `google` (API Gemini): **imagem + áudio + vídeo**
- `groq`: **áudio**
- `deepgram`: **áudio**

Para entradas de CLI, **defina `capabilities` explicitamente** para evitar correspondências inesperadas.
Se você omitir `capabilities`, a entrada é elegível para a lista em que aparece.

## Matriz de suporte de provedores (integrações OpenClaw)

| Capacidade | Integração de provedor                           | Notas                                                                                  |
| ---------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Imagem     | OpenAI / Anthropic / Google / outros via `pi-ai` | Qualquer modelo com suporte a imagem no registry funciona.             |
| Áudio      | OpenAI, Groq, Deepgram, Google                   | Transcrição por provedor (Whisper/Deepgram/Gemini). |
| Vídeo      | Google (API Gemini)           | Compreensão de vídeo pelo provedor.                                    |

## Provedores recomendados

**Imagem**

- Prefira seu modelo ativo se ele suportar imagens.
- Bons padrões: `openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`.

**Áudio**

- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo` ou `deepgram/nova-3`.
- Fallback via CLI: `whisper-cli` (whisper-cpp) ou `whisper`.
- Configuração do Deepgram: [Deepgram (transcrição de áudio)](/providers/deepgram).

**Vídeo**

- `google/gemini-3-flash-preview` (rápido), `google/gemini-3-pro-preview` (mais rico).
- Fallback via CLI: CLI `gemini` (suporta `read_file` em vídeo/áudio).

## Política de anexos

A `attachments` por capacidade controla quais anexos são processados:

- `mode`: `first` (padrão) ou `all`
- `maxAttachments`: limita a quantidade processada (padrão **1**)
- `prefer`: `first`, `last`, `path`, `url`

Quando `mode: "all"`, as saídas são rotuladas como `[Image 1/2]`, `[Audio 2/2]`, etc.

## Exemplos de configuração

### 1. Lista de modelos compartilhados + substituições

```json5
{
  tools: {
    media: {
      models: [
        { provider: "openai", model: "gpt-5.2", capabilities: ["image"] },
        {
          provider: "google",
          model: "gemini-3-flash-preview",
          capabilities: ["image", "audio", "video"],
        },
        {
          type: "cli",
          command: "gemini",
          args: [
            "-m",
            "gemini-3-flash",
            "--allowed-tools",
            "read_file",
            "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
          ],
          capabilities: ["image", "video"],
        },
      ],
      audio: {
        attachments: { mode: "all", maxAttachments: 2 },
      },
      video: {
        maxChars: 500,
      },
    },
  },
}
```

### 2. Apenas Áudio + Vídeo (imagem desativada)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
          },
        ],
      },
      video: {
        enabled: true,
        maxChars: 500,
        models: [
          { provider: "google", model: "gemini-3-flash-preview" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 3. Compreensão de imagem opcional

```json5
{
  tools: {
    media: {
      image: {
        enabled: true,
        maxBytes: 10485760,
        maxChars: 500,
        models: [
          { provider: "openai", model: "gpt-5.2" },
          { provider: "anthropic", model: "claude-opus-4-6" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 4. Entrada única multimodal (capacidades explícitas)

```json5
{
  tools: {
    media: {
      image: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      audio: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      video: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
    },
  },
}
```

## Saída de status

Quando a compreensão de mídia é executada, `/status` inclui uma linha de resumo curta:

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

Isso mostra os resultados por capacidade e o provedor/modelo escolhido quando aplicável.

## Notas

- A compreensão é **best-effort**. Erros não bloqueiam respostas.
- Os anexos ainda são enviados aos modelos mesmo quando a compreensão está desativada.
- Use `scope` para limitar onde a compreensão é executada (por exemplo, apenas DMs).

## Documentos relacionados

- [Configuração](/gateway/configuration)
- [Suporte a Imagens e Mídia](/nodes/images)
