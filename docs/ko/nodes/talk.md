---
read_when:
    - macOS/iOS/Android에서 Talk 모드 구현
    - 음성/TTS/인터럽트 동작 변경
summary: 'Talk 모드: ElevenLabs TTS를 통한 지속적인 음성 대화'
title: 토크 모드
x-i18n:
    generated_at: "2026-02-08T16:04:02Z"
    model: gtx
    provider: google-translate
    source_hash: ecbc3701c9e9502970cf13227fedbc9714d13668d8f4f3988fef2a4d68116a42
    source_path: nodes/talk.md
    workflow: 15
---

# 토크 모드

대화 모드는 지속적인 음성 대화 루프입니다.

1. 연설 듣기
2. 모델에 기록 보내기(기본 세션, chat.send)
3. 응답을 기다리세요
4. ElevenLabs를 통해 말해보세요(스트리밍 재생)

## 동작(macOS)

- **상시 오버레이** Talk 모드가 활성화된 동안.
- **듣기 → 생각하기 → 말하기** 위상 전환.
- 에 **짧은 멈춤** (무음 창) 현재 기록이 전송됩니다.
- 답글은 다음과 같습니다 **웹챗에 기록됨** (입력과 동일).
- **연설 중단** (기본값 켜짐): 어시스턴트가 말하는 동안 사용자가 말하기 시작하면 재생을 중지하고 다음 프롬프트에 대한 중단 타임스탬프를 기록합니다.

## 답장의 음성 지시문

어시스턴트는 응답 앞에 다음을 붙일 수 있습니다. **단일 JSON 라인** 음성을 제어하려면:

```json
{ "voice": "<voice-id>", "once": true }
```

규칙:

- 비어 있지 않은 첫 번째 줄만.
- 알 수 없는 키는 무시됩니다.
- `once: true` 현재 응답에만 적용됩니다.
- 없이 `once`, 음성은 대화 모드의 새로운 기본값이 됩니다.
- JSON 라인은 TTS 재생 전에 제거됩니다.

지원되는 키:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## 구성(`~/.openclaw/openclaw.json`)

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

기본값:

- `interruptOnSpeech`: 진실
- `voiceId`: 다음으로 돌아갑니다. `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (또는 API 키를 사용할 수 있는 경우 첫 번째 ElevenLabs 음성)
- `modelId`: 기본값은 `eleven_v3` 설정되지 않은 경우
- `apiKey`: 다음으로 돌아갑니다. `ELEVENLABS_API_KEY` (또는 사용 가능한 경우 게이트웨이 셸 프로필)
- `outputFormat`: 기본값은 `pcm_44100` macOS/iOS 및 `pcm_24000` Android(설정됨 `mp3_*` MP3 스트리밍을 강제하려면)

## 맥OS UI

- 메뉴 표시줄 토글: **말하다**
- 구성 탭: **토크 모드** 그룹(음성 ID + 인터럽트 토글)
- 씌우다:
  - **청취**: 마이크 레벨이 포함된 클라우드 펄스
  - **생각**: 가라앉는 애니메이션
  - **말하기**: 방사 링
  - 클릭 클라우드: 말하기 중지
  - X 클릭: 대화 모드 종료

## 메모

- 음성 + 마이크 권한이 필요합니다.
- 용도 `chat.send` 세션 키에 대해 `main`.
- TTS는 ElevenLabs 스트리밍 API를 사용합니다. `ELEVENLABS_API_KEY` 대기 시간을 줄이기 위해 macOS/iOS/Android에서 증분 재생이 가능합니다.
- `stability` ~을 위한 `eleven_v3` 으로 검증됩니다 `0.0`, `0.5`, 또는 `1.0`; 다른 모델은 허용 `0..1`.
- `latency_tier` 으로 검증됩니다 `0..4` 설정하면.
- 안드로이드 지원 `pcm_16000`, `pcm_22050`, `pcm_24000`, 그리고 `pcm_44100` 지연 시간이 짧은 AudioTrack 스트리밍을 위한 출력 형식입니다.
