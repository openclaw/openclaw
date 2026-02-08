---
read_when:
    - 답장을 위해 텍스트 음성 변환 활성화
    - TTS 공급자 또는 제한 구성
    - /tts 명령 사용
summary: 아웃바운드 응답을 위한 TTS(텍스트 음성 변환)
title: 텍스트 음성 변환
x-i18n:
    generated_at: "2026-02-08T16:07:01Z"
    model: gtx
    provider: google-translate
    source_hash: 070ff0cc8592f64c6c9e4ddaddc7e8fba82f0692ceded6fe833ec9ba5b61e6fb
    source_path: tts.md
    workflow: 15
---

# 텍스트 음성 변환(TTS)

OpenClaw는 ElevenLabs, OpenAI 또는 Edge TTS를 사용하여 아웃바운드 응답을 오디오로 변환할 수 있습니다.
OpenClaw가 오디오를 전송할 수 있는 모든 곳에서 작동합니다. 텔레그램에는 둥근 음성 메모 버블이 있습니다.

## 지원되는 서비스

- **일레븐랩스** (기본 또는 대체 공급자)
- **오픈AI** (기본 또는 대체 공급자, 요약에도 사용됨)
- **엣지 TTS** (기본 또는 대체 공급자, 다음을 사용합니다. `node-edge-tts`, API 키가 없는 경우 기본값)

### 엣지 TTS 메모

Edge TTS는 다음을 통해 Microsoft Edge의 온라인 신경 TTS 서비스를 사용합니다. `node-edge-tts`
도서관. 로컬이 아닌 호스팅된 서비스이고 Microsoft의 엔드포인트를 사용하며 다음을 수행합니다.
API 키가 필요하지 않습니다. `node-edge-tts` 음성 구성 옵션을 노출하고
출력 형식이지만 모든 옵션이 Edge 서비스에서 지원되는 것은 아닙니다. citeturn2search0

Edge TTS는 게시된 SLA 또는 할당량이 없는 공개 웹 서비스이므로 이를 처리하십시오.
최선의 노력으로. 보장된 제한과 지원이 필요한 경우 OpenAI 또는 ElevenLabs를 사용하세요.
Microsoft의 Speech REST API는 요청당 오디오 제한을 10분으로 문서화합니다. 엣지 TTS
한도를 게시하지 않으므로 비슷하거나 더 낮은 한도를 가정합니다. citeturn0search3

## 선택적 키

OpenAI 또는 ElevenLabs를 원하는 경우:

- `ELEVENLABS_API_KEY` (또는 `XI_API_KEY`)
- `OPENAI_API_KEY`

엣지 TTS는 **~ 아니다** API 키가 필요합니다. API 키가 발견되지 않으면 OpenClaw가 기본값을 사용합니다.
Edge TTS로(다음을 통해 비활성화되지 않은 경우) `messages.tts.edge.enabled=false`).

여러 공급자가 구성된 경우 선택한 공급자가 먼저 사용되고 나머지 공급자는 대체 옵션입니다.
자동 요약은 구성된 `summaryModel` (또는 `agents.defaults.model.primary`),
따라서 요약을 활성화하는 경우 공급자도 인증되어야 합니다.

## 서비스 링크

- [OpenAI 텍스트 음성 변환 가이드](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI 오디오 API 참조](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs 텍스트 음성 변환](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs 인증](https://elevenlabs.io/docs/api-reference/authentication)
- [노드-에지-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft 음성 출력 형식](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## 기본적으로 활성화되어 있나요?

아니요. 자동 TTS는 **끄다** 기본적으로. 구성에서 활성화하십시오.
`messages.tts.auto` 또는 세션당 `/tts always` (별명: `/tts on`).

엣지 TTS**~이다** TTS가 켜져 있으면 기본적으로 활성화되며 자동으로 사용됩니다.
OpenAI 또는 ElevenLabs API 키를 사용할 수 없는 경우.

## 구성

TTS 구성은 `messages.tts` ~에 `openclaw.json`.
전체 스키마가 있습니다. [게이트웨이 구성](/gateway/configuration).

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

### 엣지 TTS 비활성화

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

### 수신 음성 메모 후에만 오디오로 회신하세요.

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### 긴 답장에 대한 자동 요약 비활성화

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

### 필드에 대한 참고 사항

- `auto`: 자동 TTS 모드(`off`, `always`, `inbound`, `tagged`).
  - `inbound` 인바운드 음성 메모 후에만 오디오를 보냅니다.
  - `tagged` 응답에 다음이 포함된 경우에만 오디오를 보냅니다. `[[tts]]` 태그.
- `enabled`: 레거시 토글(의사가 이를 다음으로 마이그레이션함) `auto`).
- `mode`: `"final"` (기본값) 또는 `"all"` (도구/블록 응답 포함)
- `provider`: `"elevenlabs"`, `"openai"`, 또는 `"edge"` (대체는 자동입니다).
- 만약에 `provider`~이다**설정되지 않음**, OpenClaw가 선호함 `openai` (키인 경우), 그런 다음 `elevenlabs` (키인 경우),
  그렇지 않으면 `edge`.
- `summaryModel`: 자동 요약을 위한 저렴한 모델 옵션; 기본값은 `agents.defaults.model.primary`.
  - 수락 `provider/model` 또는 구성된 모델 별칭.
- `modelOverrides`: 모델이 TTS 지시문을 내보낼 수 있도록 허용합니다(기본적으로 켜져 있음).
- `maxTextLength`: TTS 입력(문자)에 대한 하드 캡입니다. `/tts audio` 초과하면 실패합니다.
- `timeoutMs`: 요청 시간 초과(ms)입니다.
- `prefsPath`: 로컬 기본 설정 JSON 경로(공급자/한계/요약)를 재정의합니다.
- `apiKey` 값은 env vars(`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: ElevenLabs API 기본 URL을 재정의합니다.
- `elevenlabs.voiceSettings`: 
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = 정상)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2글자 ISO 639-1(예: `en`, `de`)
- `elevenlabs.seed`: 정수 `0..4294967295` (최선의 결정론)
- `edge.enabled`: Edge TTS 사용을 허용합니다(기본값 `true`; API 키 없음).
- `edge.voice`: Edge 신경 음성 이름(예: `en-US-MichelleNeural`).
- `edge.lang`: 언어 코드(예: `en-US`).
- `edge.outputFormat`: Edge 출력 형식(예: `audio-24khz-48kbitrate-mono-mp3`).
  - 유효한 값은 Microsoft 음성 출력 형식을 참조하세요. Edge에서는 모든 형식이 지원되는 것은 아닙니다.
- `edge.rate`/`edge.pitch`/`edge.volume`: 퍼센트 문자열(예: `+10%`, `-5%`).
- `edge.saveSubtitles`: 오디오 파일과 함께 JSON 자막을 작성합니다.
- `edge.proxy`: Edge TTS 요청의 프록시 URL입니다.
- `edge.timeoutMs`: 시간 초과 재정의를 요청합니다(ms).

## 모델 기반 재정의(기본값은 켜짐)

기본적으로 모델은 **~할 수 있다** 단일 응답에 대해 TTS 지시문을 내보냅니다.
언제 `messages.tts.auto`~이다`tagged`, 이러한 지시문은 오디오를 트리거하는 데 필요합니다.

활성화되면 모델이 방출할 수 있습니다. `[[tts:...]]` 음성을 무시하라는 지시
단일 답변 및 선택사항 `[[tts:text]]...[[/tts:text]]` 차단하다
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
- `voice` (OpenAI 음성) 또는 `voiceId` (일레븐랩스)
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

슬래시 명령은 로컬 재정의를 다음에 기록합니다. `prefsPath` (기본:
`~/.openclaw/settings/tts.json`, 다음으로 재정의 `OPENCLAW_TTS_PREFS` 또는
`messages.tts.prefsPath`).

저장된 필드:

- `enabled`
- `provider`
- `maxLength` (요약 임계값, 기본값 1,500자)
- `summarize` (기본 `true`)

이는 재정의됩니다. `messages.tts.*` 그 호스트를 위해.

## 출력 형식(고정)

- **전보**: Opus 음성 메모 (`opus_48000_64` ElevenLabs에서, `opus` OpenAI에서).
  - 48kHz/64kbps는 좋은 음성 메모 절충안이며 둥근 버블에 필요합니다.
- **기타 채널**: MP3 (`mp3_44100_128` ElevenLabs에서, `mp3` OpenAI에서).
  - 44.1kHz/128kbps는 음성 선명도를 위한 기본 밸런스입니다.
- **엣지 TTS**: 사용 `edge.outputFormat` (기본 `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` 받아들인다 `outputFormat`, 그러나 모든 형식을 사용할 수 있는 것은 아닙니다.
    Edge 서비스에서. citeturn2search0
  - 출력 형식 값은 Microsoft 음성 출력 형식(Ogg/WebM Opus 포함)을 따릅니다. citeturn1search0
  - 전보`sendVoice` OGG/MP3/M4A를 허용합니다. 필요한 경우 OpenAI/ElevenLabs를 사용하세요.
    Opus 음성 메모가 보장됩니다. citeturn1search1
  - 구성된 Edge 출력 형식이 실패하면 OpenClaw는 MP3로 다시 시도합니다.

OpenAI/ElevenLabs 형식은 고정되어 있습니다. 텔레그램은 음성노트 UX에 Opus를 기대하고 있습니다.

## 자동 TTS 동작

활성화되면 OpenClaw는 다음을 수행합니다.

- 응답에 이미 미디어가 포함되어 있으면 TTS를 건너뜁니다. `MEDIA:` 지령.
- 매우 짧은 답변(< 10자)을 건너뜁니다.
- 다음을 사용하여 활성화하면 긴 답글을 요약합니다. `agents.defaults.model.primary` (또는 `summaryModel`).
- 생성된 오디오를 응답에 첨부합니다.

답변이 초과된 경우 `maxLength` 요약이 꺼져 있습니다(또는 API 키가 없습니다).
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

## 슬래시 명령 사용법

단일 명령이 있습니다. `/tts`.
보다 [슬래시 명령](/tools/slash-commands) 활성화 세부정보를 확인하세요.

불일치 참고 사항: `/tts` 내장된 Discord 명령이므로 OpenClaw가 등록합니다.
`/voice` 거기의 기본 명령으로. 텍스트 `/tts ...` 여전히 작동합니다.

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
- `commands.text` 또는 기본 명령 등록을 활성화해야 합니다.
- `off|always|inbound|tagged` 세션별 ​​토글(`/tts on` 의 별칭입니다 `/tts always`).
- `limit` 그리고 `summary` 기본 구성이 아닌 로컬 기본 설정에 저장됩니다.
- `/tts audio` 일회성 오디오 응답을 생성합니다(TTS를 설정하지 않음).

## 에이전트 도구

그만큼 `tts` 도구는 텍스트를 음성으로 변환하고 `MEDIA:` 길. 때
결과는 Telegram과 호환되며 도구에는 다음이 포함됩니다. `[[audio_as_voice]]` 그래서
텔레그램은 음성 버블을 보냅니다.

## 게이트웨이 RPC

게이트웨이 방법:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
