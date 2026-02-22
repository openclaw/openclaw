````markdown
---
summary: "아웃바운드 응답에 대한 음성 합성 (TTS)"
read_when:
  - 응답에 대한 음성 합성 활성화
  - TTS 프로바이더 또는 한계치 구성
  - /tts 명령어 사용
title: "음성 합성 (TTS)"
---

# 음성 합성 (TTS)

OpenClaw는 ElevenLabs, OpenAI 또는 Edge TTS를 사용하여 아웃바운드 응답을 오디오로 변환할 수 있습니다. 이는 OpenClaw가 오디오를 전송할 수 있는 모든 곳에서 작동하며, Telegram에서는 둥근 음성 노트 버블로 표시됩니다.

## 지원되는 서비스

- **ElevenLabs** (기본 또는 대체 프로바이더)
- **OpenAI** (기본 또는 대체 프로바이더; 요약에도 사용됨)
- **Edge TTS** (기본 또는 대체 프로바이더; `node-edge-tts` 사용, API 키가 없을 때 기본값)

### Edge TTS 주의사항

Edge TTS는 `node-edge-tts` 라이브러리를 통해 Microsoft Edge의 온라인 뉴럴 TTS 서비스를 사용합니다. 이는 호스팅된 서비스(로컬이 아님)이며, Microsoft의 엔드포인트를 사용하며 API 키가 필요하지 않습니다. `node-edge-tts`는 음성 구성 옵션과 출력 형식을 제공합니다, 하지만 모든 옵션이 Edge 서비스에서 지원되지는 않습니다.

Edge TTS는 공공 웹 서비스로 SLA 또는 쿼터가 공개되지 않았으므로 최선의 노력으로 취급해야 합니다. 보장된 한계치와 지원이 필요하다면 OpenAI나 ElevenLabs를 사용하십시오. Microsoft의 Speech REST API는 요청당 10분 오디오 한계를 문서화하고 있으며, Edge TTS는 한계를 공개하지 않으므로 비슷하거나 낮은 한계를 가정하십시오.

## 선택적 키

OpenAI나 ElevenLabs를 사용하려면:

- `ELEVENLABS_API_KEY` (또는 `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS는 **API 키가 필요하지 않습니다**. API 키가 발견되지 않으면, OpenClaw는 기본적으로 Edge TTS (활성화되지 않은 경우 `messages.tts.edge.enabled=false`를 통해 비활성화)로 설정됩니다.

여러 프로바이더가 구성된 경우, 선택된 프로바이더가 먼저 사용되고 다른 프로바이더는 대체 옵션으로 사용됩니다. 자동 요약은 구성된 `summaryModel` (또는 `agents.defaults.model.primary`)을 사용하며, 요약을 활성화한 경우 해당 프로바이더도 인증되어야 합니다.

## 서비스 링크

- [OpenAI 음성 합성 가이드](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI 오디오 API 참조](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs 음성 합성](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs 인증](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech 출력 형식](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## 기본으로 활성화된 상태인가요?

아니요. 자동 TTS는 기본적으로 **비활성화**되어 있습니다. `messages.tts.auto`를 사용해 구성에서 활성화하거나 `/tts always` (별칭: `/tts on`)를 사용해 세션별로 활성화하십시오.

TTS가 활성화되면 Edge TTS는 기본적으로 활성화되며, OpenAI 또는 ElevenLabs API 키가 없는 경우 자동으로 사용됩니다.

## 설정

TTS 설정은 `openclaw.json`의 `messages.tts`에 있습니다. 전체 스키마는 [Gateway 구성](/gateway/configuration)에 있습니다.

### 최소 설정 (활성화 + 프로바이더)

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
````

### OpenAI 기본, ElevenLabs 대체

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

### Edge TTS 기본 (API 키 없음)

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

### Edge TTS 비활성화

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

### 사용자 지정 한계치 및 환경 설정 경로

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

### 인바운드 음성 노트를 받은 후에만 음성으로 응답

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### 긴 응답에 대한 자동 요약 비활성화

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

그런 다음 실행합니다:

```
/tts summary off
```

### 필드에 대한 주의사항

- `auto`: 자동 TTS 모드 (`off`, `always`, `inbound`, `tagged`).
  - `inbound`는 인바운드 음성 노트를 받은 후에만 오디오를 전송합니다.
  - `tagged`는 `[[tts]]` 태그가 포함된 경우에만 오디오를 전송합니다.
- `enabled`: 레거시 토글 (doctor가 이를 `auto`로 마이그레이션합니다).
- `mode`: `"final"` (기본값) 또는 `"all"` (도구/블록 응답 포함).
- `provider`: `"elevenlabs"`, `"openai"`, 또는 `"edge"` (대체는 자동).
- `provider`가 설정되지 않은 경우, OpenClaw는 `openai` (키가 있는 경우), 그 후 `elevenlabs` (키가 있는 경우), 그렇지 않으면 `edge`를 선호합니다.
- `summaryModel`: 자동 요약용 선택적 저가 모델; 기본값은 `agents.defaults.model.primary`.
  - `provider/model`이나 설정된 모델 별칭을 수락합니다.
- `modelOverrides`: 모델이 TTS 지시를 발행할 수 있도록 허용 (기본값으로 활성화).
- `maxTextLength`: TTS 입력에 대한 하드 캡 (문자). `/tts audio`가 초과되면 실패합니다.
- `timeoutMs`: 요청 타임아웃 (ms).
- `prefsPath`: 로컬 환경 설정 JSON 경로 재정의 (프로바이더/한계/요약).
- `apiKey` 값은 환경 변수 (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`)로 대체됩니다.
- `elevenlabs.baseUrl`: ElevenLabs API 기본 URL 재정의.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = 정상)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2글자 ISO 639-1 (예: `en`, `de`)
- `elevenlabs.seed`: 정수 `0..4294967295` (최선의 노력 결정론)
- `edge.enabled`: Edge TTS 사용 허용 (기본값 `true`; API 키 없음).
- `edge.voice`: Edge 뉴럴 음성 이름 (예: `en-US-MichelleNeural`).
- `edge.lang`: 언어 코드 (예: `en-US`).
- `edge.outputFormat`: Edge 출력 형식 (예: `audio-24khz-48kbitrate-mono-mp3`).
  - Microsoft Speech 출력 형식에서 유효한 값을 참조하십시오; 모든 형식이 Edge에서 지원되지 않습니다.
- `edge.rate` / `edge.pitch` / `edge.volume`: 백분위 문자열 (예: `+10%`, `-5%`).
- `edge.saveSubtitles`: 오디오 파일과 함께 JSON 자막 작성.
- `edge.proxy`: Edge TTS 요청을 위한 프록시 URL.
- `edge.timeoutMs`: 요청 타임아웃 재정의 (ms).

## 모델 기반 재정의 (기본값으로 활성화)

기본값으로, 모델은 단일 응답에 대해 TTS 지시문을 발행할 수 있습니다. `messages.tts.auto`가 `tagged`인 경우, 이 지시문들은 오디오를 트리거하기 위해 필수입니다.

활성화되면, 모델은 `[[tts:...]]` 지시문을 발행하여 단일 응답에 대한 음성을 재정의하고, 선택적으로 `[[tts:text]]...[[/tts:text]]` 블록을 발행하여 웃음, 노래 큐와 같은 표현 태그를 제공할 수 있으며, 이는 오디오에만 나타나야 합니다.

예제 응답 페이로드:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

활성화된 경우 사용할 수 있는 지시 키:

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (OpenAI 음성) 또는 `voiceId` (ElevenLabs)
- `model` (OpenAI TTS 모델 또는 ElevenLabs 모델 ID)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

모든 모델 재정의 비활성화:

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

선택적 허용 목록 (태그를 활성화 상태로 유지하면서 특정 재정의 비활성화):

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

## 사용자별 환경 설정

슬래시 명령어는 로컬 환경 설정을 `prefsPath`(기본값: `~/.openclaw/settings/tts.json`, `OPENCLAW_TTS_PREFS` 또는 `messages.tts.prefsPath`로 재정의)에 기록합니다.

저장된 필드:

- `enabled`
- `provider`
- `maxLength` (요약 임계값; 기본 1500자)
- `summarize` (기본값 `true`)

이들은 해당 호스트에 대한 `messages.tts.*`를 재정의합니다.

## 출력 형식 (고정)

- **Telegram**: Opus 음성 노트 (`opus_48000_64` from ElevenLabs, `opus` from OpenAI).
  - 48kHz / 64kbps는 음성 노트에 적합한 트레이드 오프이며 둥근 버블에 필요합니다.
- **기타 채널**: MP3 (`mp3_44100_128` from ElevenLabs, `mp3` from OpenAI).
  - 44.1kHz / 128kbps는 음성 명료도의 기본 균형입니다.
- **Edge TTS**: `edge.outputFormat` 사용 (기본값 `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts`는 `outputFormat`을 수락하지만 모든 형식이 Edge 서비스에서 사용 가능하지 않습니다.
    Microsoft Speech 출력 형식 값을 포함한 형식 (Ogg/WebM Opus 포함).
  - Telegram `sendVoice`는 OGG/MP3/M4A를 수락합니다; 보장된 Opus 음성 노트가 필요하면 OpenAI/ElevenLabs를 사용하십시오.
  - 구성된 Edge 출력 형식이 실패하면, OpenClaw는 MP3로 재시도합니다.

OpenAI/ElevenLabs 형식은 고정됨; Telegram은 음성 노트 UX를 위해 Opus를 기대합니다.

## 자동 TTS 동작

활성화되면, OpenClaw는:

- 응답에 이미 미디어가 있거나 `MEDIA:` 지시문이 포함된 경우 TTS를 건너뜁니다.
- 매우 짧은 응답 (< 10자)을 건너뜁니다.
- 활성화된 경우, `agents.defaults.model.primary` (또는 `summaryModel`)를 사용하여 긴 응답을 요약합니다.
- 생성된 오디오를 응답에 첨부합니다.

응답이 `maxLength`를 초과하고 요약이 비활성화된 경우 (또는 요약 모델에 대한 API 키가 없는 경우), 오디오가 건너뛰어지고 일반 텍스트 응답이 전송됩니다.

## 흐름 다이어그램

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

## 슬래시 명령어 사용

명령어는 하나입니다: `/tts`. [슬래시 명령어](/tools/slash-commands)에서 활성화 세부 정보를 확인하십시오.

Discord 주의: `/tts`는 Discord의 내장 명령어이기 때문에, OpenClaw는 해당 지점에서 네이티브 명령어로 `/voice`를 등록합니다. 텍스트 `/tts ...`는 여전히 작동합니다.

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

주의 사항:

- 명령어는 인증된 발신자가 필요합니다 (허용 목록/소유자 규칙은 여전히 적용됨).
- `commands.text` 또는 네이티브 명령어 등록이 활성화되어야 합니다.
- `off|always|inbound|tagged`는 세션별로 토글됩니다 (`/tts on`은 `/tts always`의 별칭임).
- `limit` 및 `summary`는 로컬 환경 설정에 저장되며, 메인 설정에는 적용되지 않음.
- `/tts audio`는 일회성 오디오 응답을 생성하여 TTS를 켜지 않습니다.

## 에이전트 도구

`tts` 도구는 텍스트를 음성으로 변환하고 `MEDIA:` 경로를 반환합니다. 결과가 Telegram 호환되면, 도구는 `[[audio_as_voice]]`를 포함하여 Telegram이 음성 버블을 보낼 수 있도록 합니다.

## 게이트웨이 RPC

게이트웨이 메서드:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`

```

```
