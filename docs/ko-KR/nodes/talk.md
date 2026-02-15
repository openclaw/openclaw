---
summary: "Talk mode: continuous speech conversations with ElevenLabs TTS"
read_when:
  - Implementing Talk mode on macOS/iOS/Android
  - Changing voice/TTS/interrupt behavior
title: "Talk Mode"
x-i18n:
  source_hash: ecbc3701c9e9502970cf13227fedbc9714d13668d8f4f3988fef2a4d68116a42
---

# 토크 모드

대화 모드는 지속적인 음성 대화 루프입니다.

1. 말을 들어보세요
2. 모델에게 성적표 보내기(메인 세션, chat.send)
3. 응답을 기다립니다
4. ElevenLabs를 통해 말해보세요(스트리밍 재생)

## 동작(macOS)

- 말하기 모드가 활성화된 동안 **항상 켜져 있는 오버레이**.
- **듣기 → 생각하기 → 말하기** 단계 전환.
- **짧은 일시 중지**(무음 창)에 현재 기록이 전송됩니다.
- 답변은 **WebChat에 기록됩니다**(입력과 동일).
- **음성 중단**(기본값 켜짐): 어시스턴트가 말하는 동안 사용자가 말하기 시작하면 재생을 중지하고 다음 프롬프트에 대한 중단 타임스탬프를 기록합니다.

## 답글의 음성 지시어

어시스턴트는 음성을 제어하기 위해 응답 앞에 **단일 JSON 라인**을 붙일 수 있습니다.

```json
{ "voice": "<voice-id>", "once": true }
```

규칙:

- 비어 있지 않은 첫 번째 줄만 해당됩니다.
- 알 수 없는 키는 무시됩니다.
- `once: true`는 현재 답변에만 적용됩니다.
- `once`가 없으면 음성이 대화 모드의 새로운 기본값이 됩니다.
- TTS 재생 전에 JSON 라인이 제거됩니다.

지원되는 키:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## 구성 (`~/.openclaw/openclaw.json`)

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

- `interruptOnSpeech`: 참
- `voiceId`: `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID`(또는 API 키를 사용할 수 있는 경우 첫 번째 ElevenLabs 음성)로 대체됩니다.
- `modelId`: 설정 해제 시 기본값은 `eleven_v3`입니다.
- `apiKey`: `ELEVENLABS_API_KEY`(또는 사용 가능한 경우 게이트웨이 셸 프로필)로 대체됩니다.
- `outputFormat`: 기본값은 macOS/iOS에서는 `pcm_44100`이고 Android에서는 `pcm_24000`입니다(MP3 스트리밍을 강제하려면 `mp3_*`를 설정하세요).

## 맥OS UI

- 메뉴바 토글: **말하기**
- 구성 탭: **통화 모드** 그룹(음성 ID + 인터럽트 토글)
- 오버레이:
  - **듣기**: 마이크 레벨에 따른 클라우드 펄스
  - **생각**: 가라앉는 애니메이션
  - **말하기**: 방사형 고리
  - 클라우드 클릭: 말하기 중지
  - X 클릭: 토크 모드 종료

## 메모

- 음성 + 마이크 권한이 필요합니다.
- 세션 키 `main`에 대해 `chat.send`를 사용합니다.
- TTS는 지연 시간을 줄이기 위해 `ELEVENLABS_API_KEY`와 함께 ElevenLabs 스트리밍 API를 사용하고 macOS/iOS/Android에서 증분 재생을 사용합니다.
- `eleven_v3`에 대한 `stability`는 `0.0`, `0.5` 또는 `1.0`로 검증됩니다. 다른 모델은 `0..1`을 허용합니다.
- `latency_tier`는 설정 시 `0..4`로 검증됩니다.
- Android는 지연 시간이 짧은 AudioTrack 스트리밍을 위해 `pcm_16000`, `pcm_22050`, `pcm_24000` 및 `pcm_44100` 출력 형식을 지원합니다.
