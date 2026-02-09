---
summary: "인바운드 음성 메모를 위한 Deepgram 전사"
read_when:
  - 오디오 첨부 파일에 대해 Deepgram 음성-텍스트 변환이 필요합니다
  - 빠른 Deepgram 구성 예제가 필요합니다
title: "Deepgram"
---

# Deepgram (오디오 전사)

Deepgram 은 음성-텍스트 변환 API 입니다. OpenClaw 에서는 `tools.media.audio` 를 통해 **인바운드 오디오/음성 메모 전사**에 사용됩니다.

활성화되면 OpenClaw 는 오디오 파일을 Deepgram 에 업로드하고 전사 결과를 응답 파이프라인(`{{Transcript}}` + `[Audio]` 블록)에 주입합니다. 이는 **스트리밍이 아니며**, 사전 녹음 전사 엔드포인트를 사용합니다.

웹사이트: [https://deepgram.com](https://deepgram.com)  
문서: [https://developers.deepgram.com](https://developers.deepgram.com)

## 빠른 시작

1. API 키를 설정합니다:

```
DEEPGRAM_API_KEY=dg_...
```

2. 프로바이더를 활성화합니다:

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

## 옵션

- `model`: Deepgram 모델 ID (기본값: `nova-3`)
- `language`: 언어 힌트 (선택 사항)
- `tools.media.audio.providerOptions.deepgram.detect_language`: 언어 감지 활성화 (선택 사항)
- `tools.media.audio.providerOptions.deepgram.punctuate`: 구두점 활성화 (선택 사항)
- `tools.media.audio.providerOptions.deepgram.smart_format`: 스마트 포맷팅 활성화 (선택 사항)

언어를 지정한 예시:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

Deepgram 옵션을 사용한 예시:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## 참고 사항

- 인증은 표준 프로바이더 인증 순서를 따르며, `DEEPGRAM_API_KEY` 이 가장 간단한 경로입니다.
- 프록시를 사용하는 경우 `tools.media.audio.baseUrl` 및 `tools.media.audio.headers` 로 엔드포인트 또는 헤더를 재정의할 수 있습니다.
- 출력은 다른 프로바이더와 동일한 오디오 규칙(크기 제한, 타임아웃, 전사 주입)을 따릅니다.
