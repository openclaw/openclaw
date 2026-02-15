---
summary: "Text-to-speech (TTS) for outbound replies"
read_when:
  - Enabling text-to-speech for replies
  - Configuring TTS providers or limits
  - Using /tts commands
title: "Text-to-Speech"
x-i18n:
  source_hash: 070ff0cc8592f64c6c9e4ddaddc7e8fba82f0692ceded6fe833ec9ba5b61e6fb
---

# 텍스트 음성 변환(TTS)

OpenClaw는 ElevenLabs, OpenAI 또는 Edge TTS를 사용하여 아웃바운드 응답을 오디오로 변환할 수 있습니다.
OpenClaw가 오디오를 전송할 수 있는 모든 곳에서 작동합니다. 텔레그램에는 둥근 음성 메모 버블이 있습니다.

## 지원되는 서비스

- **ElevenLabs**(기본 또는 대체 공급자)
- **OpenAI**(기본 또는 대체 공급자, 요약에도 사용됨)
- **Edge TTS**(기본 또는 대체 공급자, `node-edge-tts` 사용, API 키가 없는 경우 기본값)

### 엣지 TTS 메모

Edge TTS는 `node-edge-tts`를 통해 Microsoft Edge의 온라인 신경 TTS 서비스를 사용합니다.
도서관. 로컬이 아닌 호스팅된 서비스이고 Microsoft의 엔드포인트를 사용하며 다음을 수행합니다.
API 키가 필요하지 않습니다. `node-edge-tts`는 음성 구성 옵션을 노출하고
출력 형식이지만 모든 옵션이 Edge 서비스에서 지원되는 것은 아닙니다. citeturn2search0

Edge TTS는 게시된 SLA 또는 할당량이 없는 공개 웹 서비스이므로 이를 처리하십시오.
최선의 노력으로. 보장된 제한과 지원이 필요한 경우 OpenAI 또는 ElevenLabs를 사용하세요.
Microsoft의 Speech REST API는 요청당 오디오 제한을 10분으로 문서화합니다. 엣지 TTS
한도를 게시하지 않으므로 비슷하거나 더 낮은 한도를 가정합니다. citeturn0search3

## 선택적 키

OpenAI 또는 ElevenLabs를 원하는 경우:

- `ELEVENLABS_API_KEY` (또는 `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS에는 API 키가 필요하지 **않습니다**. API 키가 발견되지 않으면 OpenClaw가 기본값을 사용합니다.
Edge TTS로(`messages.tts.edge.enabled=false`를 통해 비활성화되지 않는 한).

여러 공급자가 구성된 경우 선택한 공급자가 먼저 사용되고 나머지 공급자는 대체 옵션입니다.
자동 요약은 구성된 `summaryModel`(또는 `agents.defaults.model.primary`)를 사용합니다.
따라서 요약을 활성화하는 경우 공급자도 인증되어야 합니다.

## 서비스 링크

- [OpenAI 텍스트 음성 변환 가이드](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI 오디오 API 참조](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs 텍스트 음성 변환](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs 인증](https://elevenlabs.io/docs/api-reference/authentication)
- [노드-가장자리-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft 음성 출력 형식](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## 기본적으로 활성화되어 있나요?

아니요. 자동 TTS는 기본적으로 **꺼져** 있습니다. 구성에서 활성화하십시오.
`messages.tts.auto` 또는 `/tts always`를 사용한 세션당(별칭: `/tts on`).

Edge TTS는 TTS가 활성화되면 기본적으로 활성화되며 자동으로 사용됩니다.
OpenAI 또는 ElevenLabs API 키를 사용할 수 없는 경우.

## 구성

TTS 구성은 `openclaw.json`의 `messages.tts` 아래에 있습니다.
전체 스키마는 [게이트웨이 구성](/gateway/configuration)에 있습니다.

### 최소 구성(활성화 + 공급자)

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

### ElevenLabs 대체 기능을 갖춘 OpenAI 기본

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

### Edge TTS 기본(API 키 없음)

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

### 사용자 정의 제한 + 기본 설정 경로

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

### 수신 음성 메모 후에는 오디오로만 답장하세요.

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### 긴 답글에 대한 자동 요약 비활성화

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

그런 다음 다음을 실행하십시오.

```
/tts summary off
```

### 필드에 대한 참고사항

- `auto`: 자동 TTS 모드(`off`, `always`, `inbound`, `tagged`).
  - `inbound`는 수신 음성 메모 후에만 오디오를 보냅니다.
  - `tagged`는 답글에 `[[tts]]` 태그가 포함된 경우에만 오디오를 보냅니다.
- `enabled`: 레거시 토글(의사가 이를 `auto`로 마이그레이션함).
- `mode`: `"final"` (기본값) 또는 `"all"` (도구/블록 응답 포함).
- `provider`: `"elevenlabs"`, `"openai"` 또는 `"edge"` (대체는 자동입니다).
- `provider`가 **설정되지 않은** 경우 OpenClaw는 `openai`(키인 경우)를 선호하고 `elevenlabs`(키인 경우)을 선호합니다.
  그렇지 않으면 `edge`.
- `summaryModel`: 자동 요약을 위한 저렴한 옵션 모델; 기본값은 `agents.defaults.model.primary`입니다.
  - `provider/model` 또는 구성된 모델 별칭을 허용합니다.
- `modelOverrides`: 모델이 TTS 지시문을 내보낼 수 있도록 허용합니다(기본적으로 켜져 있음).
- `maxTextLength`: TTS 입력(문자)에 대한 하드 캡입니다. `/tts audio` 초과하면 실패합니다.
- `timeoutMs`: 요청 시간 초과(ms)입니다.
- `prefsPath`: 로컬 기본 설정 JSON 경로(공급자/한계/요약)를 재정의합니다.
- `apiKey` 값은 환경 변수(`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`)로 대체됩니다.
- `elevenlabs.baseUrl`: ElevenLabs API 기본 URL을 재정의합니다.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = 일반)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2자리 ISO 639-1(예: `en`, `de`)
- `elevenlabs.seed`: 정수 `0..4294967295` (최선형 결정론)
- `edge.enabled`: Edge TTS 사용을 허용합니다(기본값 `true`, API 키 없음).
- `edge.voice`: 에지 신경 음성 이름(예: `en-US-MichelleNeural`).
- `edge.lang`: 언어 코드(예: `en-US`).
- `edge.outputFormat`: 에지 출력 형식(예: `audio-24khz-48kbitrate-mono-mp3`).
  - 유효한 값은 Microsoft 음성 출력 형식을 참조하세요. Edge에서는 모든 형식이 지원되는 것은 아닙니다.
- `edge.rate` / `edge.pitch` / `edge.volume`: 백분율 문자열(예: `+10%`, `-5%`).
- `edge.saveSubtitles`: 오디오 파일과 함께 JSON 자막을 작성합니다.
- `edge.proxy`: Edge TTS 요청을 위한 프록시 URL입니다.
- `edge.timeoutMs`: 요청 시간 초과 재정의(ms)입니다.

## 모델 기반 재정의(기본값은 켜짐)

기본적으로 모델은 단일 응답에 대해 TTS 지시문을 **내보낼 수** 있습니다.
`messages.tts.auto`가 `tagged`인 경우 오디오를 트리거하려면 이러한 지시어가 필요합니다.

활성화되면 모델은 `[[tts:...]]` 지시어를 내보내 음성을 무시할 수 있습니다.
단일 응답의 경우 선택적인 `[[tts:text]]...[[/tts:text]]` 블록을 추가하여
에만 나타나야 하는 표현적인 태그(웃음, 노래 신호 등)를 제공합니다.
오디오.

응답 페이로드 예시:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

사용 가능한 지시문 키(활성화된 경우):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice`(OpenAI 음성) 또는 `voiceId`(ElevenLabs)
- `model` (OpenAI TTS 모델 또는 ElevenLabs 모델 ID)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

모든 모델 재정의를 비활성화합니다.

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

선택적 허용 목록(태그를 활성화한 상태로 유지하면서 특정 재정의를 비활성화함):

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

## 사용자별 기본 설정

슬래시 명령은 `prefsPath`에 로컬 재정의를 기록합니다(기본값:
`~/.openclaw/settings/tts.json`, `OPENCLAW_TTS_PREFS`로 재정의하거나
`messages.tts.prefsPath`).

저장된 필드:

- `enabled`
- `provider`
- `maxLength` (요약 임계값, 기본 1500자)
- `summarize` (기본값 `true`)

이는 해당 호스트에 대해 `messages.tts.*`를 재정의합니다.

## 출력 형식(고정)

- **텔레그램**: Opus 음성 메모(ElevenLabs의 `opus_48000_64`, OpenAI의 `opus`).
  - 48kHz/64kbps는 좋은 음성 메모 절충안이며 둥근 버블에 필요합니다.
- **기타 채널**: MP3(ElevenLabs의 `mp3_44100_128`, OpenAI의 `mp3`).
  - 44.1kHz / 128kbps는 음성 선명도를 위한 기본 밸런스입니다.
- **가장자리 TTS**: `edge.outputFormat`를 사용합니다(기본값 `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts`는 `outputFormat`를 허용하지만 모든 형식을 사용할 수 있는 것은 아닙니다.
    Edge 서비스에서. citeturn2search0
  - 출력 형식 값은 Microsoft 음성 출력 형식(Ogg/WebM Opus 포함)을 따릅니다. citeturn1search0
  - 텔레그램 `sendVoice`은 OGG/MP3/M4A를 허용합니다. 필요한 경우 OpenAI/ElevenLabs를 사용하세요.
    Opus 음성 메모가 보장됩니다. citeturn1search1
  - 구성된 Edge 출력 형식이 실패하면 OpenClaw는 MP3로 다시 시도합니다.

OpenAI/ElevenLabs 형식은 고정되어 있습니다. 텔레그램은 음성노트 UX에 Opus를 기대하고 있습니다.

## 자동 TTS 동작

활성화되면 OpenClaw는 다음을 수행합니다.

- 응답에 이미 미디어 또는 `MEDIA:` 지시문이 포함된 경우 TTS를 건너뜁니다.
- 매우 짧은 답변(< 10자)을 건너뜁니다.
- `agents.defaults.model.primary`(또는 `summaryModel`)를 사용하여 활성화한 경우 긴 답변을 요약합니다.
- 생성된 오디오를 응답에 첨부합니다.

응답이 `maxLength`를 초과하고 요약이 꺼져 있는 경우(또는 API 키가 없는 경우)
요약 모델), 오디오
건너뛰고 일반 텍스트 응답이 전송됩니다.

## 흐름도

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

## 슬래시 명령어 사용법

단일 명령이 있습니다: `/tts`.
활성화에 대한 자세한 내용은 [슬래시 명령](/tools/slash-commands)을 참조하세요.

Discord 참고사항: `/tts`는 Discord 명령에 내장되어 있으므로 OpenClaw에 등록됩니다.
`/voice`가 기본 명령으로 사용됩니다. 텍스트 `/tts ...`는 여전히 작동합니다.

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

참고:

- 명령에는 승인된 발신자가 필요합니다(허용 목록/소유자 규칙은 계속 적용됩니다).
- `commands.text` 또는 기본 명령어 등록이 활성화되어 있어야 합니다.
- `off|always|inbound|tagged`는 세션별 토글입니다(`/tts on`는 `/tts always`의 별칭입니다).
- `limit` 및 `summary`는 기본 구성이 아닌 로컬 기본 설정에 저장됩니다.
- `/tts audio`는 일회성 오디오 응답을 생성합니다(TTS를 켜진 않음).

## 에이전트 도구

`tts` 도구는 텍스트를 음성으로 변환하고 `MEDIA:` 경로를 반환합니다. 때
결과는 텔레그램과 호환되며 도구에는 `[[audio_as_voice]]`가 포함되어 있습니다.
텔레그램은 음성 버블을 보냅니다.

## 게이트웨이 RPC

게이트웨이 방법:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
