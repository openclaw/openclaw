---
summary: "프로바이더 + CLI 폴백을 통한 인바운드 이미지/오디오/비디오 이해 (선택 사항)"
read_when:
  - 미디어 이해 설계 또는 리팩터링 시
  - 인바운드 오디오/비디오/이미지 전처리 튜닝 시
title: "미디어 이해"
---

# 미디어 이해 (인바운드) — 2026-01-17

OpenClaw 는 답변 파이프라인이 실행되기 전에 **인바운드 미디어**(이미지/오디오/비디오)를 **요약**할 수 있습니다. 로컬 도구 또는 프로바이더 키가 사용 가능한지 자동으로 감지하며, 비활성화하거나 사용자 정의할 수 있습니다. 이해 기능이 꺼져 있어도 모델은 평소와 같이 원본 파일/URL 을 그대로 받습니다.

## 목표

- 선택 사항: 인바운드 미디어를 짧은 텍스트로 사전 소화하여 더 빠른 라우팅과 더 나은 명령 파싱을 제공.
- 원본 미디어 전달을 모델에 항상 보존.
- **프로바이더 API** 와 **CLI 폴백** 지원.
- 오류/크기/타임아웃에 따른 순서형 폴백을 갖춘 다중 모델 허용.

## 상위 수준 동작

1. 인바운드 첨부 수집 (`MediaPaths`, `MediaUrls`, `MediaTypes`).
2. 활성화된 각 기능(이미지/오디오/비디오)에 대해 정책에 따라 첨부 선택(기본값: **첫 번째**).
3. 적합한 첫 번째 모델 항목 선택(크기 + 기능 + 인증).
4. 모델이 실패하거나 미디어가 너무 크면 **다음 항목으로 폴백**.
5. 성공 시:
   - `Body` 가 `[Image]`, `[Audio]`, 또는 `[Video]` 블록이 됩니다.
   - 오디오는 `{{Transcript}}` 를 설정하며, 명령 파싱은 캡션 텍스트가 있으면 이를 사용하고, 없으면 전사를 사용합니다.
   - 캡션은 블록 내부의 `User text:` 로 보존됩니다.

이해가 실패하거나 비활성화되면 **답변 흐름은 계속**되며 원본 본문 + 첨부가 사용됩니다.

## 설정 개요

`tools.media` 는 **공유 모델**과 기능별 재정의를 지원합니다:

- `tools.media.models`: 공유 모델 목록 (`capabilities` 로 게이팅).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - 기본값 (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - 프로바이더 재정의 (`baseUrl`, `headers`, `providerOptions`)
  - `tools.media.audio.providerOptions.deepgram` 를 통한 Deepgram 오디오 옵션
  - 선택 사항: **기능별 `models` 목록** (공유 모델보다 우선)
  - `attachments` 정책 (`mode`, `maxAttachments`, `prefer`)
  - `scope` (채널/채팅 유형/세션 키 기준의 선택적 게이팅)
- `tools.media.concurrency`: 동시 기능 실행 최대 수 (기본값 **2**).

```json5
{
  tools: {
    media: {
      models: [
        /* shared list */
      ],
      image: {
        /* optional overrides */
      },
      audio: {
        /* optional overrides */
      },
      video: {
        /* optional overrides */
      },
    },
  },
}
```

### 모델 항목

각 `models[]` 항목은 **프로바이더** 또는 **CLI** 일 수 있습니다:

```json5
{
  type: "provider", // default if omitted
  provider: "openai",
  model: "gpt-5.2",
  prompt: "Describe the image in <= 500 chars.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // optional, used for multi‑modal entries
  profile: "vision-profile",
  preferredProfile: "vision-fallback",
}
```

```json5
{
  type: "cli",
  command: "gemini",
  args: [
    "-m",
    "gemini-3-flash",
    "--allowed-tools",
    "read_file",
    "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
  ],
  maxChars: 500,
  maxBytes: 52428800,
  timeoutSeconds: 120,
  capabilities: ["video", "image"],
}
```

CLI 템플릿은 다음도 사용할 수 있습니다:

- `{{MediaDir}}` (미디어 파일이 포함된 디렉토리)
- `{{OutputDir}}` (이번 실행을 위해 생성된 스크래치 디렉토리)
- `{{OutputBase}}` (확장자 없는 스크래치 파일 기본 경로)

## 기본값과 제한

권장 기본값:

- `maxChars`: 이미지/비디오 **500** (짧고 명령 친화적)
- `maxChars`: 오디오 **미설정** (제한을 설정하지 않으면 전체 전사)
- `maxBytes`:
  - 이미지: **10MB**
  - 오디오: **20MB**
  - 비디오: **50MB**

규칙:

- 미디어가 `maxBytes` 를 초과하면 해당 모델을 건너뛰고 **다음 모델을 시도**합니다.
- 모델이 `maxChars` 보다 많이 반환하면 출력이 잘립니다.
- `prompt` 는 기본적으로 간단한 “Describe the {media}.” 와 `maxChars` 가이드를 사용합니다(이미지/비디오만).
- `<capability>.enabled: true` 이지만 모델이 구성되지 않은 경우, 해당 기능을 지원하는 프로바이더라면 OpenClaw 는 **활성 답변 모델**을 시도합니다.

### 미디어 이해 자동 감지 (기본값)

`tools.media.<capability>.enabled` 가 `false` 로 설정되지 않았고 모델을 구성하지 않았다면, OpenClaw 는 다음 순서로 자동 감지하며 **첫 번째로 작동하는 옵션에서 중지**합니다:

1. **로컬 CLI** (오디오만; 설치된 경우)
   - `sherpa-onnx-offline` (`SHERPA_ONNX_MODEL_DIR` 필요: encoder/decoder/joiner/tokens)
   - `whisper-cli` (`whisper-cpp`; `WHISPER_CPP_MODEL` 또는 번들된 tiny 모델 사용)
   - `whisper` (Python CLI; 모델 자동 다운로드)
2. **Gemini CLI** (`gemini`) — `read_many_files` 사용
3. **프로바이더 키**
   - 오디오: OpenAI → Groq → Deepgram → Google
   - 이미지: OpenAI → Anthropic → Google → MiniMax
   - 비디오: Google

자동 감지를 비활성화하려면 다음을 설정하십시오:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: false,
      },
    },
  },
}
```

참고: 바이너리 감지는 macOS/Linux/Windows 전반에서 최선의 노력으로 수행됩니다. CLI 가 `PATH` 에 있는지 확인하십시오(`~` 를 확장합니다). 또는 전체 명령 경로가 포함된 명시적 CLI 모델을 설정하십시오.

## 기능 (선택 사항)

`capabilities` 를 설정하면 해당 항목은 지정된 미디어 유형에 대해서만 실행됩니다. 공유 목록의 경우 OpenClaw 가 기본값을 추론할 수 있습니다:

- `openai`, `anthropic`, `minimax`: **이미지**
- `google` (Gemini API): **이미지 + 오디오 + 비디오**
- `groq`: **오디오**
- `deepgram`: **오디오**

CLI 항목의 경우, 예상치 못한 매칭을 피하기 위해 **`capabilities` 를 명시적으로 설정**하십시오.
`capabilities` 를 생략하면, 해당 항목은 포함된 목록에 대해 적합한 것으로 간주됩니다.

## 프로바이더 지원 매트릭스 (OpenClaw 통합)

| 기능  | 프로바이더 통합                                      | 참고                                                                    |
| --- | --------------------------------------------- | --------------------------------------------------------------------- |
| 이미지 | OpenAI / Anthropic / Google / `pi-ai` 를 통한 기타 | 레지스트리의 모든 이미지 지원 모델이 동작합니다.                           |
| 오디오 | OpenAI, Groq, Deepgram, Google                | 프로바이더 전사(Whisper/Deepgram/Gemini). |
| 비디오 | Google (Gemini API)        | 프로바이더 비디오 이해.                                         |

## 권장 프로바이더

**이미지**

- 이미지 지원 시 활성 모델을 우선 사용하십시오.
- 권장 기본값: `openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`.

**오디오**

- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo`, 또는 `deepgram/nova-3`.
- CLI 폴백: `whisper-cli` (whisper-cpp) 또는 `whisper`.
- Deepgram 설정: [Deepgram (audio transcription)](/providers/deepgram).

**비디오**

- `google/gemini-3-flash-preview` (빠름), `google/gemini-3-pro-preview` (더 풍부함).
- CLI 폴백: `gemini` CLI (`read_file` 를 비디오/오디오에서 지원).

## 첨부 정책

기능별 `attachments` 는 처리할 첨부를 제어합니다:

- `mode`: `first` (기본값) 또는 `all`
- `maxAttachments`: 처리할 개수 상한 (기본값 **1**)
- `prefer`: `first`, `last`, `path`, `url`

`mode: "all"` 인 경우 출력은 `[Image 1/2]`, `[Audio 2/2]` 등으로 레이블링됩니다.

## 설정 예제

### 1. 공유 모델 목록 + 재정의

```json5
{
  tools: {
    media: {
      models: [
        { provider: "openai", model: "gpt-5.2", capabilities: ["image"] },
        {
          provider: "google",
          model: "gemini-3-flash-preview",
          capabilities: ["image", "audio", "video"],
        },
        {
          type: "cli",
          command: "gemini",
          args: [
            "-m",
            "gemini-3-flash",
            "--allowed-tools",
            "read_file",
            "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
          ],
          capabilities: ["image", "video"],
        },
      ],
      audio: {
        attachments: { mode: "all", maxAttachments: 2 },
      },
      video: {
        maxChars: 500,
      },
    },
  },
}
```

### 2. 오디오 + 비디오만 (이미지 끔)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
          },
        ],
      },
      video: {
        enabled: true,
        maxChars: 500,
        models: [
          { provider: "google", model: "gemini-3-flash-preview" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 3. 선택적 이미지 이해

```json5
{
  tools: {
    media: {
      image: {
        enabled: true,
        maxBytes: 10485760,
        maxChars: 500,
        models: [
          { provider: "openai", model: "gpt-5.2" },
          { provider: "anthropic", model: "claude-opus-4-6" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 4. 멀티모달 단일 항목 (명시적 기능)

```json5
{
  tools: {
    media: {
      image: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      audio: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      video: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
    },
  },
}
```

## 상태 출력

미디어 이해가 실행되면 `/status` 에 짧은 요약 줄이 포함됩니다:

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

이는 기능별 결과와 적용 가능한 경우 선택된 프로바이더/모델을 보여줍니다.

## 참고

- 이해는 **최선의 노력**으로 수행됩니다. 오류는 답변을 차단하지 않습니다.
- 이해가 비활성화되어도 첨부는 여전히 모델로 전달됩니다.
- 이해가 실행되는 위치를 제한하려면 `scope` 를 사용하십시오(예: 다이렉트 메시지 전용).

## 관련 문서

- [Configuration](/gateway/configuration)
- [Image & Media Support](/nodes/images)
