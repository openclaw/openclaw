---
summary: "Talk 모드: ElevenLabs TTS와 연속 음성 대화"
read_when:
  - macOS/iOS/Android에서 Talk 모드 구현하기
  - 음성/TTS/중단 동작 변경하기
title: "Talk 모드"
---

# Talk 모드

Talk 모드는 연속적인 음성 대화 루프입니다:

1. 음성을 듣습니다
2. 대본을 모델에 전송합니다 (주 세션, chat.send)
3. 응답을 기다립니다
4. ElevenLabs를 통해 읽어줍니다 (스트리밍 재생)

## 동작 (macOS)

- Talk 모드가 활성화된 동안 **항상 켜져 있는 오버레이**.
- **듣기 → 생각하기 → 말하기** 단계 전환.
- **짧은 일시정지** (무음 창) 시, 현재 대본이 전송됩니다.
- 응답은 **WebChat에 작성**됩니다 (타이핑과 동일).
- **음성 중단** (기본값 사용): 사용자가 에이전트가 말하는 동안 말을 시작하면 재생이 중지되고 다음 프롬프트를 위해 중단 타임스탬프가 기록됩니다.

## 응답에서의 음성 지시어

에이전트는 음성을 제어하기 위해 답변에 **단일 JSON 행**을 접두어로 붙일 수 있습니다:

```json
{ "voice": "<voice-id>", "once": true }
```

규칙:

- 첫 번째 비어 있지 않은 행만 사용.
- 알 수 없는 키는 무시됩니다.
- `once: true`는 현재 응답에만 적용됩니다.
- `once`가 없으면 해당 음성이 Talk 모드의 새 기본값이 됩니다.
- TTS 재생 전에 JSON 행이 제거됩니다.

지원되는 키:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## 설정 (`~/.openclaw/openclaw.json`)

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

- `interruptOnSpeech`: true
- `voiceId`: `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID`로 대체 (또는 API 키가 있는 경우 첫 번째 ElevenLabs 음성)
- `modelId`: 설정되지 않은 경우 기본값 `eleven_v3`
- `apiKey`: `ELEVENLABS_API_KEY`로 대체 (또는 사용 가능한 경우 게이트웨이 셸 프로파일)
- `outputFormat`: macOS/iOS에서는 기본값 `pcm_44100`, Android에서는 기본값 `pcm_24000` (MP3 스트리밍을 강제하려면 `mp3_*` 설정)

## macOS UI

- 메뉴 바 토글: **Talk**
- 설정 탭: **Talk 모드** 그룹 (음성 ID + 중단 토글)
- 오버레이:
  - **Listening**: 마이크 레벨과 클라우드 펄싱
  - **Thinking**: 싱킹 애니메이션
  - **Speaking**: 방사형 고리
  - 클라우드 클릭: 말하기 중지
  - X 클릭: Talk 모드 종료

## 주의사항

- 음성 및 마이크 권한이 필요합니다.
- 세션 키 `main`에 대해 `chat.send`를 사용합니다.
- TTS는 `ELEVENLABS_API_KEY`를 사용하여 ElevenLabs 스트리밍 API와 macOS/iOS/Android에서 지연 시간을 줄이기 위한 점진적 재생을 사용합니다.
- `eleven_v3`의 `stability`는 `0.0`, `0.5`, 또는 `1.0`으로 검증되며, 다른 모델은 `0..1`을 허용합니다.
- `latency_tier`는 설정 시 `0..4`로 검증됩니다.
- Android는 낮은 지연 시간의 AudioTrack 스트리밍을 위한 `pcm_16000`, `pcm_22050`, `pcm_24000` 및 `pcm_44100` 출력 포맷을 지원합니다.
