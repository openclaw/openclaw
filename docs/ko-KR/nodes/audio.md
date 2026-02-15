---
summary: "How inbound audio/voice notes are downloaded, transcribed, and injected into replies"
read_when:
  - Changing audio transcription or media handling
title: "Audio and Voice Notes"
x-i18n:
  source_hash: 0910d4b14c59bdfa4c9fb77f3e1afd48f7fa16005af7126c68e656222e3e90ef
---

# 오디오/음성 메모 — 2026-01-17

## 작동하는 것

- **미디어 이해(오디오)**: 오디오 이해가 활성화(또는 자동 감지)된 경우 OpenClaw:
  1. 첫 번째 오디오 첨부 파일(로컬 경로 또는 URL)을 찾고 필요한 경우 다운로드합니다.
  2. 각 모델 항목으로 보내기 전에 `maxBytes`를 적용합니다.
  3. 첫 번째 적격 모델 항목을 순서대로 실행합니다(공급자 또는 CLI).
  4. 실패하거나 건너뛰는 경우(크기/시간 초과) 다음 항목을 시도합니다.
  5. 성공하면 `Body`를 `[Audio]` 블록으로 대체하고 `{{Transcript}}`를 설정합니다.
- **명령 구문 분석**: 전사가 성공하면 `CommandBody`/`RawBody`가 전사에 설정되므로 슬래시 명령이 계속 작동합니다.
- **자세한 로깅**: `--verbose`에서는 전사가 실행될 때와 본문을 대체할 때 기록합니다.

## 자동 감지(기본값)

**모델을 구성하지 않고** `tools.media.audio.enabled`가 `false`로 **설정되지 않은** 경우,
OpenClaw는 다음 순서로 자동 감지하고 첫 번째 작업 옵션에서 중지합니다.

1. **로컬 CLI**(설치된 경우)
   - `sherpa-onnx-offline` (인코더/디코더/조이너/토큰과 함께 `SHERPA_ONNX_MODEL_DIR` 필요)
   - `whisper-cli` (`whisper-cpp`에서; `WHISPER_CPP_MODEL` 또는 번들로 제공되는 작은 모델을 사용함)
   - `whisper` (Python CLI; 자동으로 모델 다운로드)
2. **Gemini CLI** (`gemini`) `read_many_files` 사용
3. **공급자 키**(OpenAI → Groq → Deepgram → Google)

자동 감지를 비활성화하려면 `tools.media.audio.enabled: false`을 설정하세요.
사용자 정의하려면 `tools.media.audio.models`를 설정하세요.
참고: 바이너리 감지는 macOS/Linux/Windows에서 최선의 노력을 다합니다. CLI가 `PATH`에 있는지 확인하거나(`~` 확장) ​​전체 명령 경로를 사용하여 명시적인 CLI 모델을 설정합니다.

## 구성 예

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

## 참고 및 제한사항

- 공급자 인증은 표준 모델 인증 순서(인증 프로필, 환경 변수, `models.providers.*.apiKey`)를 따릅니다.
- 딥그램은 `provider: "deepgram"`를 사용할 때 `DEEPGRAM_API_KEY`를 선택합니다.
- 딥그램 설정 내용 : [딥그램(오디오 전사)](/providers/deepgram).
- 오디오 제공자는 `tools.media.audio`를 통해 `baseUrl`, `headers` 및 `providerOptions`를 재정의할 수 있습니다.
- 기본 크기 제한은 20MB입니다(`tools.media.audio.maxBytes`). 해당 모델에서는 특대 오디오를 건너뛰고 다음 항목이 시도됩니다.
- 오디오의 기본 `maxChars`는 **설정되지 않음**(전체 내용)입니다. 출력을 트리밍하려면 `tools.media.audio.maxChars` 또는 항목별 `maxChars`를 설정합니다.
- OpenAI 자동 기본값은 `gpt-4o-mini-transcribe`입니다. 정확도를 높이려면 `model: "gpt-4o-transcribe"`를 설정하세요.
- `tools.media.audio.attachments`를 사용하여 여러 음성 메모(`mode: "all"` + `maxAttachments`)를 처리합니다.
- 성적표는 `{{Transcript}}`로 템플릿에 사용할 수 있습니다.
- CLI 표준 출력이 제한됩니다(5MB). CLI 출력을 간결하게 유지하세요.

## 그룹 내 멘션 감지

`requireMention: true`가 그룹 채팅으로 설정되면 OpenClaw는 이제 멘션을 확인하기 **전에** 오디오를 기록합니다. 이를 통해 음성 메모에 멘션이 포함된 경우에도 처리할 수 있습니다.

**작동 방식:**

1. 음성 메시지에 텍스트 본문이 없고 그룹에서 언급이 필요한 경우 OpenClaw는 "실행 전" 전사를 수행합니다.
2. 녹취록에서 언급 패턴(예: `@BotName`, 이모티콘 트리거)이 있는지 확인합니다.
3. 멘션이 발견되면 메시지는 전체 응답 파이프라인을 통해 진행됩니다.
4. 녹취록은 멘션 감지에 사용되므로 음성 메모가 멘션 게이트를 통과할 수 있습니다.

**대체 동작:**

- 실행 전(시간 초과, API 오류 등) 중에 전사가 실패하는 경우 텍스트 전용 멘션 감지를 기반으로 메시지가 처리됩니다.
- 이렇게 하면 혼합 메시지(텍스트 + 오디오)가 잘못 삭제되는 일이 발생하지 않습니다.

**예:** 사용자가 "안녕 @Claude, 날씨는 어때?"라는 음성 메모를 보냅니다. `requireMention: true`를 사용하는 텔레그램 그룹에 있습니다. 음성 메모가 녹음되고 멘션이 감지되면 상담원이 응답합니다.

## 알았어

- 범위 규칙은 첫 번째 일치 승리를 사용합니다. `chatType`는 `direct`, `group` 또는 `room`로 정규화됩니다.
- CLI가 0을 종료하고 일반 텍스트를 인쇄하는지 확인하세요. JSON은 `jq -r .text`를 통해 마사지되어야 합니다.
- 응답 대기열이 차단되는 것을 방지하려면 시간 제한을 적절하게 유지하십시오(`timeoutSeconds`, 기본값은 60초).
- 프리플라이트 전사는 멘션 감지를 위해 **첫 번째** 오디오 첨부 파일만 처리합니다. 추가 오디오는 기본 미디어 이해 단계에서 처리됩니다.
