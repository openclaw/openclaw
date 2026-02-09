---
summary: "아웃바운드 응답을 위한 텍스트 음성 변환 (TTS)"
read_when:
  - 응답에 텍스트 음성 변환 활성화
  - TTS 프로바이더 또는 제한 구성
  - /tts 명령 사용
title: "텍스트 음성 변환"
---

# 텍스트 음성 변환 (TTS)

OpenClaw 는 ElevenLabs, OpenAI 또는 Edge TTS 를 사용하여 아웃바운드 응답을 오디오로 변환할 수 있습니다.
OpenClaw 가 오디오를 전송할 수 있는 모든 곳에서 작동하며, Telegram 에서는 둥근 음성 메시지 버블로 표시됩니다.

## 지원 서비스

- **ElevenLabs** (기본 또는 대체 프로바이더)
- **OpenAI** (기본 또는 대체 프로바이더; 요약에도 사용됨)
- **Edge TTS** (기본 또는 대체 프로바이더; `node-edge-tts` 사용, API 키가 없을 때 기본값)

### Edge TTS 참고 사항

Edge TTS 는 `node-edge-tts` 라이브러리를 통해 Microsoft Edge 의 온라인 신경망 TTS 서비스를 사용합니다. 로컬이 아닌 호스팅 서비스이며, Microsoft 엔드포인트를 사용하고 API 키가 필요하지 않습니다. `node-edge-tts` 는 음성 구성 옵션과 출력 형식을 노출하지만, 모든 옵션이 Edge 서비스에서 지원되지는 않습니다. citeturn2search0

Edge TTS 는 게시된 SLA 나 할당량이 없는 공개 웹 서비스이므로, 최선 노력(best-effort)으로 취급해야 합니다. 보장된 제한과 지원이 필요하다면 OpenAI 또는 ElevenLabs 를 사용하십시오.
Microsoft 의 Speech REST API 문서에는 요청당 10분 오디오 제한이 명시되어 있으며, Edge TTS 는 제한을 공개하지 않으므로 유사하거나 더 낮은 제한을 가정해야 합니다. citeturn0search3

## 선택적 키

OpenAI 또는 ElevenLabs 를 사용하려면 다음이 필요합니다:

- `ELEVENLABS_API_KEY` (또는 `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS 는 API 키가 **필요하지 않습니다**. API 키가 발견되지 않으면 OpenClaw 는
Edge TTS 를 기본으로 사용합니다(`messages.tts.edge.enabled=false` 를 통해 비활성화하지 않은 경우).

여러 프로바이더가 구성된 경우, 선택된 프로바이더가 먼저 사용되고 나머지는 대체 옵션으로 사용됩니다.
자동 요약은 구성된 `summaryModel` (또는 `agents.defaults.model.primary`) 를 사용하므로,
요약을 활성화하는 경우 해당 프로바이더도 인증되어야 합니다.

## 서비스 링크

- [OpenAI Text-to-Speech 가이드](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API 레퍼런스](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs 인증](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech 출력 형식](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## 기본적으로 활성화되어 있습니까?

아니요. 자동 TTS 는 기본적으로 **꺼져** 있습니다. 구성에서 `messages.tts.auto` 로
또는 세션별로 `/tts always` (별칭: `/tts on`) 를 사용하여 활성화하십시오.

TTS 가 켜지면 Edge TTS 는 기본적으로 **활성화**되며,
OpenAI 또는 ElevenLabs API 키가 없는 경우 자동으로 사용됩니다.

## 구성

TTS 구성은 `openclaw.json` 의 `messages.tts` 아래에 위치합니다.
전체 스키마는 [Gateway 구성](/gateway/configuration)을 참조하십시오.

### 최소 구성 (활성화 + 프로바이더)

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

### OpenAI 기본 + ElevenLabs 대체

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

### 사용자 정의 제한 + prefs 경로

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

### 인바운드 음성 노트 이후에만 오디오로 응답

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

그런 다음 실행:

```
/tts summary off
```

### 필드 참고 사항

- `auto`: 자동 TTS 모드 (`off`, `always`, `inbound`, `tagged`).
  - `inbound` 는 인바운드 음성 노트 이후에만 오디오를 전송합니다.
  - `tagged` 는 응답에 `[[tts]]` 태그가 포함된 경우에만 오디오를 전송합니다.
- `enabled`: 레거시 토글 (doctor 가 이를 `auto` 으로 마이그레이션합니다).
- `mode`: `"final"` (기본값) 또는 `"all"` (도구/블록 응답 포함).
- `provider`: `"elevenlabs"`, `"openai"`, 또는 `"edge"` (대체는 자동).
- `provider` 가 **설정되지 않은 경우**, OpenClaw 는 `openai` (키가 있는 경우)를 선호하고,
  그 다음 `elevenlabs` (키가 있는 경우), 그렇지 않으면 `edge` 을 사용합니다.
- `summaryModel`: 자동 요약을 위한 선택적 저가 모델; 기본값은 `agents.defaults.model.primary` 입니다.
  - `provider/model` 또는 구성된 모델 별칭을 허용합니다.
- `modelOverrides`: 모델이 TTS 지시자를 출력하도록 허용합니다(기본값 켜짐).
- `maxTextLength`: TTS 입력에 대한 하드 상한(문자 수). 초과 시 `/tts audio` 가 실패합니다.
- `timeoutMs`: 요청 타임아웃(ms).
- `prefsPath`: 로컬 prefs JSON 경로 재정의(프로바이더/제한/요약).
- `apiKey` 값은 환경 변수(`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`)로 대체됩니다.
- `elevenlabs.baseUrl`: ElevenLabs API 기본 URL 재정의.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = 보통)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2자리 ISO 639-1 (예: `en`, `de`)
- `elevenlabs.seed`: 정수 `0..4294967295` (최선 노력 기반 결정성)
- `edge.enabled`: Edge TTS 사용 허용 (기본값 `true`; API 키 없음).
- `edge.voice`: Edge 신경망 음성 이름 (예: `en-US-MichelleNeural`).
- `edge.lang`: 언어 코드 (예: `en-US`).
- `edge.outputFormat`: Edge 출력 형식 (예: `audio-24khz-48kbitrate-mono-mp3`).
  - 유효한 값은 Microsoft Speech 출력 형식을 참조하십시오. Edge 에서 모든 형식이 지원되지는 않습니다.
- `edge.rate` / `edge.pitch` / `edge.volume`: 퍼센트 문자열 (예: `+10%`, `-5%`).
- `edge.saveSubtitles`: 오디오 파일과 함께 JSON 자막을 작성합니다.
- `edge.proxy`: Edge TTS 요청을 위한 프록시 URL.
- `edge.timeoutMs`: 요청 타임아웃 재정의(ms).

## 모델 기반 재정의 (기본값 켜짐)

기본적으로 모델은 단일 응답에 대해 TTS 지시자를 출력할 **수 있습니다**.
`messages.tts.auto` 이 `tagged` 인 경우, 이러한 지시자가 오디오를 트리거하는 데 필요합니다.

활성화되면, 모델은 단일 응답에 대해 음성을 재정의하기 위한 `[[tts:...]]` 지시자와,
오디오에만 포함되어야 하는 표현 태그(웃음, 노래 큐 등)를 제공하기 위한
선택적 `[[tts:text]]...[[/tts:text]]` 블록을 출력할 수 있습니다.

응답 페이로드 예시:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

사용 가능한 지시자 키(활성화된 경우):

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

선택적 허용 목록(태그는 유지하면서 특정 재정의 비활성화):

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

## 사용자별 환경설정

슬래시 명령은 로컬 재정의를 `prefsPath` 에 기록합니다(기본값:
`~/.openclaw/settings/tts.json`, `OPENCLAW_TTS_PREFS` 또는
`messages.tts.prefsPath` 으로 재정의 가능).

저장되는 필드:

- `enabled`
- `provider`
- `maxLength` (요약 임계값; 기본값 1500자)
- `summarize` (기본값 `true`)

이 값들은 해당 호스트에 대해 `messages.tts.*` 를 재정의합니다.

## 출력 형식 (고정)

- **Telegram**: Opus 음성 노트 (ElevenLabs 는 `opus_48000_64`, OpenAI 는 `opus`).
  - 48kHz / 64kbps 는 음성 노트에 적절한 절충안이며 둥근 버블에 필요합니다.
- **기타 채널**: MP3 (ElevenLabs 는 `mp3_44100_128`, OpenAI 는 `mp3`).
  - 44.1kHz / 128kbps 는 음성 명료도를 위한 기본 균형입니다.
- **Edge TTS**: `edge.outputFormat` 을 사용합니다(기본값 `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` 는 `outputFormat` 을 허용하지만, Edge 서비스에서 모든 형식을 제공하지는 않습니다. citeturn2search0
  - 출력 형식 값은 Microsoft Speech 출력 형식을 따릅니다(Ogg/WebM Opus 포함). citeturn1search0
  - Telegram `sendVoice` 는 OGG/MP3/M4A 를 허용합니다. 보장된 Opus 음성 노트가 필요하다면
    OpenAI 또는 ElevenLabs 를 사용하십시오. citeturn1search1
  - 구성된 Edge 출력 형식이 실패하면 OpenClaw 는 MP3 로 재시도합니다.

OpenAI/ElevenLabs 형식은 고정되어 있으며, Telegram 은 음성 노트 UX 를 위해 Opus 를 기대합니다.

## 자동 TTS 동작

활성화되면 OpenClaw 는 다음을 수행합니다:

- 응답에 이미 미디어 또는 `MEDIA:` 지시자가 포함된 경우 TTS 를 건너뜁니다.
- 매우 짧은 응답(< 10자)을 건너뜁니다.
- 활성화된 경우 `agents.defaults.model.primary` (또는 `summaryModel`) 를 사용하여 긴 응답을 요약합니다.
- 생성된 오디오를 응답에 첨부합니다.

응답이 `maxLength` 를 초과하고 요약이 꺼져 있거나
요약 모델용 API 키가 없는 경우,
오디오는 건너뛰고 일반 텍스트 응답이 전송됩니다.

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

## 슬래시 명령 사용법

단일 명령이 있습니다: `/tts`.
활성화 세부 사항은 [슬래시 명령](/tools/slash-commands)을 참조하십시오.

Discord 참고 사항: `/tts` 는 Discord 기본 명령이므로, OpenClaw 는
해당 환경에서 네이티브 명령으로 `/voice` 를 등록합니다. 텍스트 `/tts ...` 는 여전히 작동합니다.

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

- 명령은 권한이 부여된 발신자가 필요합니다(허용 목록/소유자 규칙이 계속 적용됨).
- `commands.text` 또는 네이티브 명령 등록이 활성화되어야 합니다.
- `off|always|inbound|tagged` 는 세션별 토글입니다(`/tts on` 는 `/tts always` 의 별칭).
- `limit` 및 `summary` 는 메인 구성 파일이 아니라 로컬 prefs 에 저장됩니다.
- `/tts audio` 는 일회성 오디오 응답을 생성합니다(TTS 를 켜거나 끄지 않습니다).

## 에이전트 도구

`tts` 도구는 텍스트를 음성으로 변환하고 `MEDIA:` 경로를 반환합니다. 결과가 Telegram 과 호환되는 경우, Telegram 이 음성 버블을 전송하도록
`[[audio_as_voice]]` 를 포함합니다.

## Gateway RPC

Gateway 메서드:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
