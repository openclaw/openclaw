---
summary: "들어오는 오디오/음성 노트가 다운로드되고 전사되며 답변에 주입되는 방법"
read_when:
  - 오디오 전사 또는 미디어 처리 변경 시
title: "오디오 및 음성 노트"
---

# Audio / Voice Notes — 2026-01-17

## What works

- **미디어 이해 (오디오)**: 오디오 이해가 활성화되었거나 자동 감지된 경우, OpenClaw는 다음과 같이 처리합니다:
  1. 첫 번째 오디오 첨부 파일(로컬 경로나 URL)을 찾아 필요하면 다운로드합니다.
  2. 각 모델 항목으로 보내기 전에 `maxBytes`를 적용합니다.
  3. (프로바이더 또는 CLI) 순서대로 첫 번째 적합한 모델 항목을 실행합니다.
  4. 실패하거나 건너뛰는 경우(크기/시간 초과) 다음 항목을 시도합니다.
  5. 성공 시, `Body`를 `[Audio]` 블록으로 대체하고 `{{Transcript}}`을 설정합니다.
- **명령어 파싱**: 전사가 성공하면, `CommandBody`/`RawBody`는 전사된 내용으로 설정되어 슬래시 명령어가 여전히 작동합니다.
- **상세 로깅**: `--verbose`에서 전사가 실행되거나 본문을 대체할 때 로그를 남깁니다.

## Auto-detection (default)

모델을 **설정하지 않고** `tools.media.audio.enabled`가 **false**로 설정되지 않은 경우, OpenClaw는 다음 순서로 자동 감지하며 첫 번째 작동 옵션에서 멈춥니다:

1. **Local CLI** (설치된 경우)
   - `sherpa-onnx-offline` (`SHERPA_ONNX_MODEL_DIR`을 사용하여 인코더/디코더/조이너/토큰 필요)
   - `whisper-cli` (`whisper-cpp`에서; `WHISPER_CPP_MODEL` 또는 번들된 작은 모델 사용)
   - `whisper` (Python CLI; 자동으로 모델 다운로드)
2. **Gemini CLI** (`gemini`) `read_many_files` 사용
3. **Provider keys** (OpenAI → Groq → Deepgram → Google)

자동 감지를 비활성화하려면, `tools.media.audio.enabled: false`로 설정하십시오. 맞춤 설정을 원하면, `tools.media.audio.models`를 설정하십시오. 바이너리 감지는 macOS/Linux/Windows 전반에 걸쳐 베스트 에포트 방식이며, CLI가 `PATH`에 있는지 확인하거나, 전체 명령 경로로 명시적인 CLI 모델을 설정하십시오.

## Config examples

### Provider + CLI fallback (OpenAI + Whisper CLI)

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

### Provider-only with scope gating

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

### Provider-only (Deepgram)

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

## Notes & limits

- 프로바이더 인증은 표준 모델 인증 순서를 따릅니다 (인증 프로파일, 환경 변수, `models.providers.*.apiKey`).
- `provider: "deepgram"`을 사용할 때 Deepgram은 `DEEPGRAM_API_KEY`를 사용합니다.
- Deepgram 설정 세부 사항: [Deepgram (audio transcription)](/ko-KR/providers/deepgram).
- 오디오 프로바이더는 `tools.media.audio`를 통해 `baseUrl`, `headers`, `providerOptions`를 재정의할 수 있습니다.
- 기본 크기 제한은 20MB (`tools.media.audio.maxBytes`)입니다. 크기 초과 오디오 파일은 해당 모델에서 건너뛰고 다음 항목이 시도됩니다.
- 오디오에 대한 기본 `maxChars`는 **설정되지 않음** (전체 전사). 출력이 잘리도록 `tools.media.audio.maxChars` 또는 항목별 `maxChars`를 설정하십시오.
- OpenAI 자동 기본값은 `gpt-4o-mini-transcribe`입니다; 더 높은 정확성을 위해 `model: "gpt-4o-transcribe"` 설정하십시오.
- 여러 음성 노트를 처리하려면 `tools.media.audio.attachments`를 사용하십시오 (`mode: "all"` + `maxAttachments`).
- 전사 결과는 `{{Transcript}}` 템플릿으로 사용할 수 있습니다.
- CLI 표준 출력은 (5MB)로 제한됩니다; CLI 출력을 간결하게 유지하십시오.

## Mention Detection in Groups

그룹 채팅에서 `requireMention: true`가 설정된 경우, OpenClaw는 이제 멘션 확인 전에 **오디오를 전사**합니다. 이를 통해 음성 노트가 멘션을 포함하더라도 처리될 수 있습니다.

**작동 방식:**

1. 음성 메시지에 텍스트 본문이 없고 그룹에 멘션이 필요한 경우, OpenClaw는 "사전 전사"를 수행합니다.
2. 전사된 내용에서 멘션 패턴(예: `@BotName`, 이모지 트리거)을 확인합니다.
3. 멘션이 발견되면, 메시지는 전체 응답 파이프라인을 통과합니다.
4. 음성 노트는 멘션 게이트를 통과할 수 있도록 전사된 내용이 멘션 감지에 사용됩니다.

**폴백 동작:**

- 사전 전사 중 전사가 실패한 경우 (시간 초과, API 오류 등), 메시지는 텍스트 전용 멘션 감지를 기반으로 처리됩니다.
- 이는 혼합 메시지 (텍스트 + 오디오)가 잘못 드롭되지 않도록 보장합니다.

**예시:** 한 사용자가 "Hey @Claude, what's the weather?"라는 음성 노트를 `requireMention: true` 설정된 Telegram 그룹에 보냅니다. 음성 노트는 전사되고, 멘션이 감지되며, 에이전트가 응답합니다.

## Gotchas

- 범위 규칙은 최초 일치 우선 원칙을 사용합니다. `chatType`은 `direct`, `group`, 또는 `room`으로 표준화됩니다.
- CLI가 0으로 종료하며 일반 텍스트를 출력하는지 확인하십시오; JSON은 `jq -r .text`를 통해 변환해야 합니다.
- 시간 초과(`timeoutSeconds`, 기본 60s)를 합리적으로 유지하여 응답 대기열을 차단하지 않도록 하십시오.
- 사전 전사는 멘션 감지를 위해 **첫 번째** 오디오 첨부 파일만 처리합니다. 추가 오디오는 주요 미디어 이해 단계에서 처리됩니다.