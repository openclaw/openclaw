---
summary: "Texto para fala (TTS) para respostas de saída"
read_when:
  - Ativando texto para fala para respostas
  - Configurando provedores ou limites de TTS
  - Usando comandos /tts
title: "Texto para Fala"
---

# Texto para fala (TTS)

O OpenClaw pode converter respostas de saída em áudio usando ElevenLabs, OpenAI ou Edge TTS.
Funciona em qualquer lugar em que o OpenClaw possa enviar áudio; no Telegram, aparece como um balão redondo de mensagem de voz.

## Serviços suportados

- **ElevenLabs** (provedor primário ou de fallback)
- **OpenAI** (provedor primário ou de fallback; também usado para resumos)
- **Edge TTS** (provedor primário ou de fallback; usa `node-edge-tts`, padrão quando não há chaves de API)

### Notas sobre o Edge TTS

O Edge TTS usa o serviço online de TTS neural do Microsoft Edge por meio da biblioteca
`node-edge-tts`. É um serviço hospedado (não local), usa endpoints da Microsoft e não
exige uma chave de API. `node-edge-tts` expõe opções de configuração de fala e formatos
de saída, mas nem todas as opções são suportadas pelo serviço Edge. citeturn2search0

Como o Edge TTS é um serviço web público sem SLA ou cota publicados, trate-o como
best-effort. Se você precisar de limites garantidos e suporte, use OpenAI ou ElevenLabs.
A API REST de Speech da Microsoft documenta um limite de áudio de 10 minutos por solicitação;
o Edge TTS não publica limites, então assuma limites semelhantes ou menores. citeturn0search3

## Chaves opcionais

Se você quiser OpenAI ou ElevenLabs:

- `ELEVENLABS_API_KEY` (ou `XI_API_KEY`)
- `OPENAI_API_KEY`

O Edge TTS **não** requer uma chave de API. Se nenhuma chave de API for encontrada, o OpenClaw
usa o Edge TTS por padrão (a menos que seja desativado via `messages.tts.edge.enabled=false`).

Se vários provedores estiverem configurados, o provedor selecionado é usado primeiro e os outros são opções de fallback.
O auto-resumo usa o `summaryModel` (ou `agents.defaults.model.primary`) configurado,
portanto esse provedor também deve estar autenticado se você ativar resumos.

## Links de serviços

- [Guia de Text-to-Speech da OpenAI](https://platform.openai.com/docs/guides/text-to-speech)
- [Referência da API de Áudio da OpenAI](https://platform.openai.com/docs/api-reference/audio)
- [Text to Speech da ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [Autenticação da ElevenLabs](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Formatos de saída do Microsoft Speech](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## É ativado por padrão?

Não. O Auto‑TTS vem **desativado** por padrão. Ative-o na configuração com
`messages.tts.auto` ou por sessão com `/tts always` (alias: `/tts on`).

O Edge TTS **fica** ativado por padrão quando o TTS está ligado e é usado automaticamente
quando não há chaves de API da OpenAI ou ElevenLabs disponíveis.

## Configuração

A configuração de TTS fica em `messages.tts` em `openclaw.json`.
O esquema completo está em [Configuração do Gateway](/gateway/configuration).

### Configuração mínima (ativar + provedor)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "elevenlabs",
    },
  },
}
```

### OpenAI primário com fallback da ElevenLabs

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openai",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
    },
  },
}
```

### Edge TTS primário (sem chave de API)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "edge",
      edge: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+10%",
        pitch: "-5%",
      },
    },
  },
}
```

### Desativar Edge TTS

```json5
{
  messages: {
    tts: {
      edge: {
        enabled: false,
      },
    },
  },
}
```

### Limites personalizados + caminho de prefs

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### Responder apenas com áudio após uma nota de voz de entrada

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Desativar auto-resumo para respostas longas

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Em seguida, execute:

```
/tts summary off
```

### Notas sobre os campos

- `auto`: modo de auto‑TTS (`off`, `always`, `inbound`, `tagged`).
  - `inbound` envia áudio apenas após uma nota de voz de entrada.
  - `tagged` envia áudio apenas quando a resposta inclui tags `[[tts]]`.
- `enabled`: alternância legada (o doctor migra isso para `auto`).
- `mode`: `"final"` (padrão) ou `"all"` (inclui respostas de ferramentas/blocos).
- `provider`: `"elevenlabs"`, `"openai"` ou `"edge"` (o fallback é automático).
- Se `provider` estiver **não definido**, o OpenClaw prefere `openai` (se houver chave), depois `elevenlabs` (se houver chave),
  caso contrário `edge`.
- `summaryModel`: modelo barato opcional para auto-resumo; padrão `agents.defaults.model.primary`.
  - Aceita `provider/model` ou um alias de modelo configurado.
- `modelOverrides`: permitir que o modelo emita diretivas de TTS (ativado por padrão).
- `maxTextLength`: limite rígido para entrada de TTS (chars). `/tts audio` falha se exceder.
- `timeoutMs`: timeout de solicitação (ms).
- `prefsPath`: sobrescrever o caminho local do JSON de prefs (provedor/limite/resumo).
- Valores de `apiKey` usam fallback para variáveis de ambiente (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: sobrescrever a URL base da API da ElevenLabs.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = normal)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: ISO 639-1 de 2 letras (ex.: `en`, `de`)
- `elevenlabs.seed`: inteiro `0..4294967295` (determinismo best-effort)
- `edge.enabled`: permitir uso do Edge TTS (padrão `true`; sem chave de API).
- `edge.voice`: nome da voz neural do Edge (ex.: `en-US-MichelleNeural`).
- `edge.lang`: código de idioma (ex.: `en-US`).
- `edge.outputFormat`: formato de saída do Edge (ex.: `audio-24khz-48kbitrate-mono-mp3`).
  - Veja os formatos de saída do Microsoft Speech para valores válidos; nem todos os formatos são suportados pelo Edge.
- `edge.rate` / `edge.pitch` / `edge.volume`: strings de porcentagem (ex.: `+10%`, `-5%`).
- `edge.saveSubtitles`: gravar legendas JSON junto ao arquivo de áudio.
- `edge.proxy`: URL de proxy para solicitações do Edge TTS.
- `edge.timeoutMs`: sobrescrita do timeout de solicitação (ms).

## Substituições orientadas pelo modelo (padrão ativado)

Por padrão, o modelo **pode** emitir diretivas de TTS para uma única resposta.
Quando `messages.tts.auto` é `tagged`, essas diretivas são necessárias para disparar o áudio.

Quando ativado, o modelo pode emitir diretivas `[[tts:...]]` para sobrescrever a voz
para uma única resposta, além de um bloco opcional `[[tts:text]]...[[/tts:text]]` para
fornecer tags expressivas (risadas, dicas de canto etc.) que devem aparecer apenas
no áudio.

Exemplo de payload de resposta:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Chaves de diretiva disponíveis (quando ativado):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (voz da OpenAI) ou `voiceId` (ElevenLabs)
- `model` (modelo TTS da OpenAI ou id do modelo da ElevenLabs)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

Desativar todas as substituições do modelo:

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

Allowlist opcional (desativar substituições específicas mantendo as tags ativadas):

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: false,
        allowSeed: false,
      },
    },
  },
}
```

## Preferências por usuário

Os comandos slash gravam substituições locais em `prefsPath` (padrão:
`~/.openclaw/settings/tts.json`, sobrescreva com `OPENCLAW_TTS_PREFS` ou
`messages.tts.prefsPath`).

Campos armazenados:

- `enabled`
- `provider`
- `maxLength` (limiar de resumo; padrão 1500 chars)
- `summarize` (padrão `true`)

Eles substituem `messages.tts.*` para esse host.

## Formatos de saída (fixos)

- **Telegram**: nota de voz Opus (`opus_48000_64` da ElevenLabs, `opus` da OpenAI).
  - 48kHz / 64kbps é um bom equilíbrio para notas de voz e é exigido para o balão redondo.
- **Outros canais**: MP3 (`mp3_44100_128` da ElevenLabs, `mp3` da OpenAI).
  - 44,1kHz / 128kbps é o equilíbrio padrão para clareza de fala.
- **Edge TTS**: usa `edge.outputFormat` (padrão `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` aceita um `outputFormat`, mas nem todos os formatos estão disponíveis
    no serviço Edge. citeturn2search0
  - Os valores de formato de saída seguem os formatos do Microsoft Speech (incluindo Ogg/WebM Opus). citeturn1search0
  - O Telegram `sendVoice` aceita OGG/MP3/M4A; use OpenAI/ElevenLabs se você precisar de
    notas de voz Opus garantidas. citeturn1search1
  - Se o formato de saída do Edge configurado falhar, o OpenClaw tenta novamente com MP3.

Os formatos da OpenAI/ElevenLabs são fixos; o Telegram espera Opus para a UX de nota de voz.

## Comportamento do Auto‑TTS

Quando ativado, o OpenClaw:

- ignora TTS se a resposta já contiver mídia ou uma diretiva `MEDIA:`.
- ignora respostas muito curtas (< 10 chars).
- resume respostas longas quando ativado usando `agents.defaults.model.primary` (ou `summaryModel`).
- anexa o áudio gerado à resposta.

Se a resposta exceder `maxLength` e o resumo estiver desligado (ou não houver chave de API para o
modelo de resumo), o áudio
é ignorado e a resposta de texto normal é enviada.

## Diagrama de fluxo

```
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / MEDIA: / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled?
                            no  -> send text
                            yes -> summarize (summaryModel or agents.defaults.model.primary)
                                      -> TTS -> attach audio
```

## Uso de comando slash

Há um único comando: `/tts`.
Veja [Comandos slash](/tools/slash-commands) para detalhes de habilitação.

Nota do Discord: `/tts` é um comando nativo do Discord, então o OpenClaw registra
`/voice` como o comando nativo lá. O texto `/tts ...` ainda funciona.

```
/tts off
/tts always
/tts inbound
/tts tagged
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Hello from OpenClaw
```

Notas:

- Os comandos exigem um remetente autorizado (regras de allowlist/proprietário ainda se aplicam).
- `commands.text` ou o registro de comando nativo devem estar ativados.
- `off|always|inbound|tagged` são alternâncias por sessão (`/tts on` é um alias para `/tts always`).
- `limit` e `summary` são armazenados nas prefs locais, não na configuração principal.
- `/tts audio` gera uma resposta de áudio pontual (não alterna o TTS).

## Ferramenta do agente

A ferramenta `tts` converte texto em fala e retorna um caminho `MEDIA:`. Quando o
resultado é compatível com o Telegram, a ferramenta inclui `[[audio_as_voice]]` para que o
Telegram envie um balão de voz.

## RPC do Gateway

Métodos do Gateway:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
