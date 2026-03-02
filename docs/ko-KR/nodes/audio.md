---
summary: "인바운드 오디오/음성 노트가 다운로드, 트랜스크라이브 및 회신에 주입되는 방식"
read_when:
  - 오디오 트랜스크라이브 또는 미디어 처리를 변경할 때
title: "오디오 및 음성 노트"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: nodes/audio.md
workflow: 15
---

# 오디오 / 음성 노트 — 2026-01-17

## 작동하는 것

- **미디어 이해(오디오)**: 오디오 이해가 활성화되면(또는 자동 감지), OpenClaw:
  1. 첫 오디오 첨부(로컬 경로 또는 URL)를 찾고 필요하면 다운로드합니다.
  2. 각 모델 항목에 전송하기 전에 `maxBytes`를 적용합니다.
  3. 순서대로 첫 적격 모델 항목을 실행합니다(제공자 또는 CLI).
  4. 실패하거나 건너뛰면(크기/타임아웃) 다음 항목을 시도합니다.
  5. 성공 시 `Body`를 `[Audio]` 블록으로 바꾸고 `{{Transcript}}`를 설정합니다.
- **커맨드 파싱**: 트랜스크라이브가 성공하면 `CommandBody`/`RawBody`가 트랜스크립트로 설정되므로 slash 커맨드가 여전히 작동합니다.
- **자세한 로깅**: `--verbose`에서 트랜스크라이브가 실행되고 본문을 바꾸는 시기를 로깅합니다.

## 자동 감지(기본값)

모델을 **구성하지 않고** `tools.media.audio.enabled`가 **`false`로 설정되지 않으면**,
OpenClaw는 이 순서대로 자동 감지하고 첫 작동 옵션에서 중지합니다:

1. **로컬 CLI**(설치된 경우)
   - `sherpa-onnx-offline`(인코더/디코더/joiner/토큰이 있는 `SHERPA_ONNX_MODEL_DIR`이 필요)
   - `whisper-cli`(`whisper-cpp`에서; `WHISPER_CPP_MODEL` 또는 번들 tiny 모델 사용)
   - `whisper`(Python CLI; 모델 자동 다운로드)
2. **Gemini CLI**(`gemini`) `read_many_files` 사용
3. **제공자 키**(OpenAI → Groq → Deepgram → Google)

자동 감지를 비활성화하려면 `tools.media.audio.enabled: false`를 설정합니다.
커스터마이즈하려면 `tools.media.audio.models`를 설정합니다.

참고: 바이너리 감지는 macOS/Linux/Windows 전반적으로 최선의 노력입니다; CLI가 `PATH`에 있는지 확인하세요(우리는 `~` 확장) 또는 전체 커맨드 경로로 명시적 CLI 모델을 설정합니다.

## 구성 예

### 제공자 + CLI 폴백(OpenAI + Whisper CLI)

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

### 제공자만(Deepgram)

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

## 참고 & 한계

- 제공자 인증은 표준 모델 인증 순서를 따릅니다(인증 프로필, 환경 변수, `models.providers.*.apiKey`).
- Deepgram은 `provider: "deepgram"`이 사용될 때 `DEEPGRAM_API_KEY`를 선택합니다.
- 오디오 제공자는 `baseUrl`, `headers` 및 `providerOptions`를 `tools.media.audio`를 통해 오버라이드할 수 있습니다.
- 기본 크기 제한은 20MB(`tools.media.audio.maxBytes`). 과도한 오디오는 해당 모델에 대해 건너뛰고 다음 항목을 시도합니다.
- 오디오의 기본 `maxChars`는 **설정 해제됨**(전체 트랜스크립트). `tools.media.audio.maxChars` 또는 항목별 `maxChars`를 설정하여 출력을 자릅니다.
- OpenAI 자동 기본값은 `gpt-4o-mini-transcribe`; 더 높은 정확도를 위해 `model: "gpt-4o-transcribe"`로 설정합니다.
- `tools.media.audio.attachments`를 사용하여 여러 음성 노트를 처리합니다(`mode: "all"` + `maxAttachments`).
- 트랜스크립트는 템플릿에서 `{{Transcript}}`로 사용 가능합니다.
- CLI stdout은 제한됩니다(5MB); CLI 출력을 간결하게 유지합니다.

## 그룹의 언급 감지

`requireMention: true`가 그룹 채팅에 설정될 때 OpenClaw는 이제 언급 확인 전에 오디오를 **트랜스크라이브**합니다. 이는 언급을 포함하는 음성 노트를 처리할 수 있게 합니다.

**작동 방식:**

1. 음성 메시지에 텍스트 본문이 없고 그룹이 언급을 필요로 하면 OpenClaw는 "사전 항공편" 트랜스크라이브를 수행합니다.
2. 트랜스크립트는 언급 패턴(예: `@BotName`, emoji 트리거)에 대해 확인됩니다.
3. 언급이 발견되면 메시지가 전체 회신 파이프라인을 통과합니다.
4. 트랜스크립트는 언급 감지에 사용되므로 음성 노트가 언급 게이트를 통과할 수 있습니다.

**폴백 동작:**

- 사전 항공편 중 트랜스크라이브가 실패하면(타임아웃, API 오류 등) 메시지는 텍스트 전용 언급 감지를 기반으로 처리됩니다.
- 이는 혼합 메시지(텍스트 + 오디오)가 절대 잘못 삭제되지 않도록 합니다.

**예**: 사용자가 `requireMention: true`인 Telegram 그룹에서 "Hey @Claude, what's the weather?"라고 말하는 음성 노트를 보냅니다. 음성 노트는 트랜스크라이브되고, 언급이 감지되고, 에이전트가 회신합니다.

## Gotchas

- 범위 규칙은 첫 일치가 이깁니다. `chatType`은 `direct`, `group` 또는 `room`으로 정규화됩니다.
- CLI가 0을 종료하고 평문 텍스트를 출력하도록 하세요; JSON은 `jq -r .text`를 통해 마사지해야 합니다.
- 타임아웃을 합리적으로 유지하세요(`timeoutSeconds`, 기본값 60초) 회신 큐를 차단하지 않도록.
- 사전 항공편 트랜스크라이브는 언급 감지를 위해 **첫** 오디오 첨부만 처리합니다. 추가 오디오는 주요 미디어 이해 단계 중에 처리됩니다.
