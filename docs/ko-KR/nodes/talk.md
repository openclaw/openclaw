---
summary: "Talk 모드: ElevenLabs TTS를 통한 연속 음성 대화"
read_when:
  - macOS/iOS/Android에서 Talk 모드를 구현할 때
  - 음성/TTS/인터럽트 동작을 변경할 때
title: "Talk 모드"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: nodes/talk.md
workflow: 15
---

# Talk 모드

Talk 모드는 연속 음성 대화 루프:

1. 음성 청취
2. 트랜스크립트를 모델로 전송(주 세션, chat.send)
3. 응답 대기
4. ElevenLabs를 통해 음성으로 말하기(스트리밍 재생)

## 동작(macOS)

- **항상 켜져 있는 오버레이** Talk 모드가 활성화되는 동안.
- **Listening → Thinking → Speaking** 단계 전환.
- **짧은 일시 중지**(침묵 윈도우)에서 현재 트랜스크립트가 전송됩니다.
- 회신이 **WebChat로 기록됨**(입력과 동일).
- **음성 중단**(기본값 켜짐): 어시스턴트가 말하는 동안 사용자가 이야기하기 시작하면 재생을 중지하고 다음 프롬프트에 대한 인터럽트 타임스탐프를 기록합니다.

## 회신의 음성 지시문

어시스턴트는 음성을 제어하기 위해 회신을 **단일 JSON 줄**로 접두사할 수 있습니다:

```json
{ "voice": "<voice-id>", "once": true }
```

규칙:

- 첫 비어있지 않은 줄만.
- 알 수 없는 키는 무시됨.
- `once: true`는 현재 회신에만 적용됨.
- `once` 없이는 음성이 Talk 모드의 새로운 기본값이 됩니다.
- JSON 줄은 TTS 재생 전에 제거됩니다.

지원되는 키:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate`(WPM), `stability`, `similarity`, `style`, `speakerBoost`
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

- `interruptOnSpeech`: true
- `voiceId`: `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID`로 폴백(또는 API 키를 사용 가능할 때 첫 ElevenLabs 음성)
- `modelId`: 설정되지 않으면 `eleven_v3`로 기본값
- `apiKey`: `ELEVENLABS_API_KEY`로 폴백(또는 사용 가능한 경우 Gateway shell 프로필)
- `outputFormat`: macOS/iOS에서 기본값 `pcm_44100`, Android에서 `pcm_24000`(MP3 스트리밍을 강제하려면 `mp3_*` 설정)

## macOS UI

- 메뉴 바 전환: **Talk**
- 구성 탭: **Talk Mode** 그룹(음성 id + 인터럽트 전환)
- 오버레이:
  - **Listening**: 클라우드가 mic 레벨로 맥박
  - **Thinking**: 가라앉는 애니메이션
  - **Speaking**: 방사 고리
  - 클라우드 클릭: 말하기 중지
  - X 클릭: Talk 모드 종료

## 참고

- 음성 + 마이크 권한 필요.
- 세션 키 `main`에 대해 `chat.send`를 사용합니다.
- TTS는 `ELEVENLABS_API_KEY` 및 macOS/iOS/Android에서 낮은 레이턴시를 위한 증분 재생으로 ElevenLabs 스트리밍 API를 사용합니다.
- `eleven_v3`의 `stability`는 `0.0`, `0.5` 또는 `1.0`로 검증; 다른 모델은 `0..1`을 수락합니다.
- `latency_tier`는 설정될 때 `0..4`로 검증됩니다.
- Android는 로우 레이턴시 AudioTrack 스트리밍을 위해 `pcm_16000`, `pcm_22050`, `pcm_24000` 및 `pcm_44100` 출력 형식을 지원합니다.
