---
read_when:
    - 오디오 전사 또는 미디어 처리 변경
summary: 인바운드 오디오/음성 메모를 다운로드하고, 기록하고, 회신에 삽입하는 방법
title: 오디오 및 음성 메모
x-i18n:
    generated_at: "2026-02-08T15:58:27Z"
    model: gtx
    provider: google-translate
    source_hash: b926c47989ab0d1ee1fb8ae6372c51d27515b53d6fefe211a85856d372f14569
    source_path: nodes/audio.md
    workflow: 15
---

# 오디오/음성 메모 — 2026-01-17

## 작동하는 것

- **미디어 이해(오디오)**: 오디오 이해가 활성화된 경우(또는 자동 감지된 경우) OpenClaw는 다음을 수행합니다.
  1. 첫 번째 오디오 첨부 파일(로컬 경로 또는 URL)을 찾아 필요한 경우 다운로드합니다.
  2. 시행 `maxBytes` 각 모델 항목으로 보내기 전에.
  3. 첫 번째 적격 모델 항목을 순서대로 실행합니다(공급자 또는 CLI).
  4. 실패하거나 건너뛰는 경우(크기/시간 초과) 다음 항목을 시도합니다.
  5. 성공하면 대체됩니다. `Body` 와 `[Audio]` 블록과 세트 `{{Transcript}}`.
- **명령 구문 분석**: 전사가 성공하면 `CommandBody`/`RawBody` 슬래시 명령이 계속 작동하도록 성적표로 설정됩니다.
- **자세한 로깅**: 안에 `--verbose`, 전사가 실행될 때와 본문이 대체될 때를 기록합니다.

## 자동 감지(기본값)

당신이 **모델을 구성하지 마세요** 그리고 `tools.media.audio.enabled` ~이다 **~ 아니다** 로 설정 `false`,
OpenClaw는 다음 순서로 자동 감지하고 첫 번째 작업 옵션에서 중지합니다.

1. **로컬 CLI** (설치된 경우)
   - `sherpa-onnx-offline` (요구 `SHERPA_ONNX_MODEL_DIR` 인코더/디코더/조이너/토큰 포함)
   - `whisper-cli` (에서 `whisper-cpp`; 용도 `WHISPER_CPP_MODEL` 또는 번들로 제공되는 소형 모델)
   - `whisper` (Python CLI; 자동으로 모델 다운로드)
2. **제미니 CLI** (`gemini`) 사용 `read_many_files`
3. **공급자 키** (OpenAI → Groq → Deepgram → 구글)

자동 감지를 비활성화하려면 다음을 설정하십시오. `tools.media.audio.enabled: false`.
맞춤설정하려면 다음을 설정하세요. `tools.media.audio.models`.
참고: 바이너리 감지는 macOS/Linux/Windows에서 최선의 노력을 다합니다. CLI가 켜져 있는지 확인하세요 `PATH` (우리는 확장 `~`) 또는 전체 명령 경로를 사용하여 명시적인 CLI 모델을 설정합니다.

## 구성 예시

### 공급자 + CLI 대체(OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### 범위 게이팅이 있는 공급자 전용

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### 공급자 전용(Deepgram)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## 참고 사항 및 한도

- 공급자 인증은 표준 모델 인증 순서(인증 프로필, 환경 변수, `models.providers.*.apiKey`).
- Deepgram이 픽업합니다. `DEEPGRAM_API_KEY` 언제 `provider: "deepgram"` 사용됩니다.
- Deepgram 설정 세부정보: [Deepgram(오디오 전사)](/providers/deepgram).
- 오디오 제공업체가 재정의할 수 있음 `baseUrl`, `headers`, 그리고 `providerOptions` ~을 통해 `tools.media.audio`.
- 기본 크기 한도는 20MB(`tools.media.audio.maxBytes`). 해당 모델에서는 특대 오디오를 건너뛰고 다음 항목이 시도됩니다.
- 기본 `maxChars` 오디오의 경우 **설정되지 않음** (전체 성적표). 세트 `tools.media.audio.maxChars` 또는 항목별 `maxChars` 출력을 다듬습니다.
- OpenAI 자동 기본값은 `gpt-4o-mini-transcribe`; 세트 `model: "gpt-4o-transcribe"` 더 높은 정확도를 위해.
- 사용 `tools.media.audio.attachments` 여러 음성 메모를 처리하려면(`mode: "all"` + `maxAttachments`).
- 성적표는 다음과 같이 템플릿에 사용할 수 있습니다. `{{Transcript}}`.
- CLI stdout은 제한되어 있습니다(5MB). CLI 출력을 간결하게 유지하세요.

## 문제

- 범위 규칙은 첫 번째 일치 승리를 사용합니다. `chatType` 정규화된다 `direct`, `group`, 또는 `room`.
- CLI가 0을 종료하고 일반 텍스트를 인쇄하는지 확인하십시오. JSON은 다음을 통해 마사지되어야 합니다. `jq -r .text`.
- 시간 초과를 합리적으로 유지합니다(`timeoutSeconds`, 기본값은 60초) 응답 대기열을 차단하지 않도록 합니다.
