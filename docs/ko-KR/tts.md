---
summary: "아웃바운드 회신용 텍스트 음성 변환 (TTS)"
read_when:
  - "회신에 대해 텍스트 음성 변환을 활성화할 때"
  - "TTS 제공자 또는 한계를 구성할 때"
  - "/tts 명령을 사용할 때"
title: "텍스트 음성 변환"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/tts.md
  workflow: 15
---

# 텍스트 음성 변환 (TTS)

OpenClaw는 ElevenLabs, OpenAI 또는 Edge TTS를 사용하여 아웃바운드 회신을 오디오로 변환할 수 있습니다.
OpenClaw가 오디오를 전송할 수 있는 곳에서 작동합니다. Telegram은 라운드 음성 노트 거품을 가집니다.

## 지원되는 서비스

- **ElevenLabs** (기본 또는 폴백 제공자)
- **OpenAI** (기본 또는 폴백 제공자; 요약에도 사용됨)
- **Edge TTS** (기본 또는 폴백 제공자; `node-edge-tts` 사용, API 키가 없을 때 기본값)

### Edge TTS 메모

Edge TTS는 `node-edge-tts` 라이브러리를 통해 Microsoft Edge의 온라인 신경 TTS 서비스를 사용합니다. 호스팅되는 서비스 (로컬이 아님), Microsoft의 엔드포인트를 사용, API 키가 필요하지 않습니다. `node-edge-tts`는 음성 구성 옵션 및 출력 포맷을 표시하지만 모든 옵션이 Edge 서비스에서 지원되는 것은 아닙니다.

Edge TTS는 공개 웹 서비스이고 공개 SLA 또는 할당량이 없으므로 최선을 다하는 것으로 취급합니다. 보장된 한계 및 지원이 필요하면 OpenAI 또는 ElevenLabs를 사용합니다.
Microsoft의 Speech REST API는 요청당 10분 오디오 한계를 문서화합니다. Edge TTS는 한계를 공개하지 않으므로 유사하거나 더 낮은 한계를 가정합니다.

## 선택적 키

OpenAI 또는 ElevenLabs를 원하면:

- `ELEVENLABS_API_KEY` (또는 `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS는 API 키가 **필요하지 않습니다**. API 키를 찾을 수 없으면 OpenClaw는 기본값으로 Edge TTS를 설정합니다 (`messages.tts.edge.enabled=false`로 비활성화하지 않으면).

여러 제공자가 구성되면 선택된 제공자가 먼저 사용되고 다른 제공자는 폴백 옵션입니다.
자동 요약은 구성된 `summaryModel` (또는 `agents.defaults.model.primary`)을 사용하므로 요약을 활성화하면 그 제공자도 인증되어야 합니다.

## 기본 설정 여부

아니요. 자동 TTS는 **기본적으로 비활성화**되어 있습니다. `messages.tts.auto` 또는 세션당 `/tts always` (별칭: `/tts on`)로 구성에서 활성화합니다.

Edge TTS **는** 기본적으로 TTS가 켜지면 활성화되며 OpenAI 또는 ElevenLabs API 키를 사용할 수 없을 때 자동으로 사용됩니다.

## 구성

TTS 구성은 `openclaw.json`의 `messages.tts`에 있습니다.
전체 스키마는 [Gateway 구성](/gateway/configuration)에 있습니다.

### 최소 구성 (활성화 + 제공자)

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

### OpenAI 기본 + ElevenLabs 폴백

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

### 커스텀 한계 + prefs 경로

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

### 인바운드 음성 노트 후에만 오디오로 회신

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### 긴 회신에 대해 자동 요약 비활성화

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

그 다음 실행:

```
/tts summary off
```

## 필드의 메모

- `auto`: 자동 TTS 모드 (`off`, `always`, `inbound`, `tagged`).
  - `inbound`는 인바운드 음성 노트 후에만 오디오를 전송합니다.
  - `tagged`는 회신이 `[[tts]]` 태그를 포함할 때만 오디오를 전송합니다.
- `enabled`: legacy 토글 (doctor는 이것을 `auto`로 마이그레이션함).
- `mode`: `"final"` (기본값) 또는 `"all"` (도구/블록 회신 포함).
- `provider`: `"elevenlabs"`, `"openai"`, 또는 `"edge"` (폴백은 자동).
- `provider`가 **설정되지 않으면** OpenClaw는 `openai` (키 있으면), 그 다음 `elevenlabs` (키 있으면), 기본값 `edge`를 선호합니다.
- `summaryModel`: 자동 요약을 위한 선택적 저렴 모델; 기본값 `agents.defaults.model.primary`.
  - `provider/model` 또는 구성된 모델 별칭을 수락합니다.
- `modelOverrides`: 모델이 TTS 지시문을 내보낼 수 있도록 허용 (기본값 on).
  - `allowProvider` 기본값 `false` (제공자 전환은 선택).
- `maxTextLength`: TTS 입력에 대한 하드 한계 (문자). 초과하면 `/tts audio` 실패.
- `timeoutMs`: 요청 타임아웃 (ms).
- `prefsPath`: 로컬 prefs JSON 경로 오버라이드 (제공자/한계/요약).
- `apiKey` 값은 env var (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`)로 폴백합니다.
- `elevenlabs.baseUrl`: ElevenLabs API 기본 URL 오버라이드.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = 정상)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2글자 ISO 639-1 (예: `en`, `de`)
- `elevenlabs.seed`: 정수 `0..4294967295` (최선 확정)
- `edge.enabled`: Edge TTS 사용 허용 (기본값 `true`; API 키 없음).
- `edge.voice`: Edge 신경 음성 이름 (예: `en-US-MichelleNeural`).
- `edge.lang`: 언어 코드 (예: `en-US`).
- `edge.outputFormat`: Edge 출력 포맷 (예: `audio-24khz-48kbitrate-mono-mp3`).
  - Microsoft Speech 출력 포맷의 유효한 값 참조; 모든 포맷이 Edge에서 지원되는 것은 아닙니다.
- `edge.rate` / `edge.pitch` / `edge.volume`: 퍼센트 문자열 (예: `+10%`, `-5%`).
- `edge.saveSubtitles`: 오디오 파일 옆에 JSON 자막을 쓰세요.
- `edge.proxy`: Edge TTS 요청을 위한 프록시 URL.
- `edge.timeoutMs`: 요청 타임아웃 오버라이드 (ms).

## 모델 구동 오버라이드 (기본값 on)

기본적으로 모델은 **할 수 있습니다** 단일 회신에 대해 TTS 지시문을 내보냅니다.
`messages.tts.auto`가 `tagged`일 때 해당 지시문은 오디오를 트리거하는 데 필수입니다.

활성화되면 모델은 `[[tts:...]]` 지시문을 내보내어 단일 회신에 대해 음성을 오버라이드할 수 있으며,
선택적 `[[tts:text]]...[[/tts:text]]` 블록을 제공하여 웃음, 노래하는 단서 등 오디오에만 나타나야 할 표현 태그를 제공합니다.

`provider=...` 지시문은 `modelOverrides.allowProvider: true`가 아니면 무시됩니다.

예제 회신 페이로드:

```
여기 있습니다.

[[tts:voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) 노래를 다시 한번 읽어주세요.[[/tts:text]]
```

사용 가능한 지시문 키 (활성화되면):

- `provider` (`openai` | `elevenlabs` | `edge`, `allowProvider: true` 필요)
- `voice` (OpenAI 음성) 또는 `voiceId` (ElevenLabs)
- `model` (OpenAI TTS 모델 또는 ElevenLabs 모델 id)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

모든 모델 오버라이드 비활성화:

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

선택적 allowlist (다른 노브를 구성 가능하게 유지하면서 제공자 전환 활성화):

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: true,
        allowSeed: false,
      },
    },
  },
}
```

## 사용자별 설정

Slash 명령은 `prefsPath`에 로컬 오버라이드를 씁니다 (기본값:
`~/.openclaw/settings/tts.json`, `OPENCLAW_TTS_PREFS` 또는
`messages.tts.prefsPath`로 오버라이드).

저장된 필드:

- `enabled`
- `provider`
- `maxLength` (요약 임계값; 기본값 1500 문자)
- `summarize` (기본값 `true`)

이것들은 그 호스트에 대해 `messages.tts.*`를 오버라이드합니다.

## 자동 TTS 동작

활성화되면 OpenClaw는:

- 회신이 이미 미디어 또는 `MEDIA:` 지시문을 포함하면 TTS를 건너뜁니다.
- 매우 짧은 회신을 건너뜁니다 (< 10 문자).
- 요약이 활성화되면 `agents.defaults.model.primary` (또는 `summaryModel`)를 사용하여 긴 회신을 요약합니다.
- 생성된 오디오를 회신에 첨부합니다.

회신이 `maxLength`를 초과하고 요약이 비활성화되었거나 요약 모델용 API 키가 없으면 오디오는
건너뛰어지고 정상 텍스트 회신을 전송합니다.

## Slash 명령 사용

하나의 명령이 있습니다: `/tts`.
활성화 세부 사항은 [Slash 명령](/tools/slash-commands)을 참조하세요.

Discord 메모: `/tts`는 기본 Discord 명령이므로 OpenClaw는 `native` 명령으로 `/voice`를 등록합니다. 텍스트 `/tts ...`는 계속 작동합니다.

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

메모:

- 명령은 권한 있는 발신자 (allowlist/owner 규칙이 여전히 적용)를 필요로 합니다.
- `commands.text` 또는 네이티브 명령 등록을 활성화해야 합니다.
- `off|always|inbound|tagged`는 세션별 토글입니다 (`/tts on`은 `/tts always`의 별칭).
- `limit` 및 `summary`는 로컬 prefs에 저장되며 메인 구성이 아닙니다.
- `/tts audio`는 일회성 오디오 회신을 생성합니다 (TTS를 켜지 않음).

## Agent 도구

`tts` 도구는 텍스트를 음성으로 변환하고 `MEDIA:` 경로를 반환합니다. 결과가 Telegram 호환되면
도구는 `[[audio_as_voice]]`를 포함하므로 Telegram이 음성 거품을 전송합니다.

## Gateway RPC

Gateway 메서드:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
