---
read_when:
    - 오디오 첨부를 위해 Deepgram 음성-텍스트 변환을 원합니다.
    - 빠른 Deepgram 구성 예제가 필요합니다
summary: 인바운드 음성 메모에 대한 Deepgram 전사
title: 딥그램
x-i18n:
    generated_at: "2026-02-08T16:00:42Z"
    model: gtx
    provider: google-translate
    source_hash: dabd1f6942c339fbd744fbf38040b6a663b06ddf4d9c9ee31e3ac034de9e79d9
    source_path: providers/deepgram.md
    workflow: 15
---

# Deepgram(오디오 전사)

Deepgram은 음성을 텍스트로 변환하는 API입니다. OpenClaw에서는 다음 용도로 사용됩니다. **인바운드 오디오/음성 메모
전사** ~을 통해 `tools.media.audio`.

활성화되면 OpenClaw는 오디오 파일을 Deepgram에 업로드하고 녹취록을 삽입합니다.
응답 파이프라인(`{{Transcript}}` + `[Audio]` 차단하다). 이것은 **스트리밍하지 않음**;
사전 녹음된 전사 엔드포인트를 사용합니다.

웹사이트: [https://deepgram.com](https://deepgram.com)  
문서: [https://developers.deepgram.com](https://developers.deepgram.com)

## 빠른 시작

1. API 키를 설정하세요.

```
DEEPGRAM_API_KEY=dg_...
```

2. 공급자를 활성화합니다.

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

- `model`: Deepgram 모델 ID(기본값: `nova-3`)
- `language`: 언어 힌트(선택 사항)
- `tools.media.audio.providerOptions.deepgram.detect_language`: 언어 감지 활성화(선택 사항)
- `tools.media.audio.providerOptions.deepgram.punctuate`: 구두점 활성화(선택 사항)
- `tools.media.audio.providerOptions.deepgram.smart_format`: 스마트 서식 활성화(선택 사항)

언어의 예:

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

Deepgram 옵션의 예:

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

## 메모

- 인증은 표준 공급자 인증 순서를 따릅니다. `DEEPGRAM_API_KEY` 가장 간단한 경로입니다.
- 끝점 또는 헤더를 다음으로 재정의합니다. `tools.media.audio.baseUrl` 그리고 `tools.media.audio.headers` 프록시를 사용할 때.
- 출력은 다른 공급자와 동일한 오디오 규칙(크기 제한, 시간 초과, 스크립트 삽입)을 따릅니다.
