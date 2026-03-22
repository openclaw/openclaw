---
title: "PDF 도구"
summary: "네이티브 프로바이더 지원 및 추출 폴백으로 하나 이상의 PDF 문서 분석"
read_when:
  - 에이전트에서 PDF 를 분석하고 싶을 때
  - 정확한 PDF 도구 파라미터와 제한을 알아야 할 때
  - 네이티브 PDF 모드와 추출 폴백을 디버깅할 때
x-i18n:
  source_path: docs/tools/pdf.md
---

# PDF 도구

`pdf`는 하나 이상의 PDF 문서를 분석하고 텍스트를 반환합니다.

주요 동작:

- Anthropic 및 Google 모델 프로바이더를 위한 네이티브 프로바이더 모드.
- 다른 프로바이더를 위한 추출 폴백 모드 (먼저 텍스트를 추출한 다음 필요시 페이지 이미지).
- 단일 (`pdf`) 또는 다중 (`pdfs`) 입력 지원, 호출당 최대 10 개 PDF.

## 가용성

에이전트에 대해 PDF 지원 모델 설정을 확인할 수 있는 경우에만 도구가 등록됩니다:

1. `agents.defaults.pdfModel`
2. `agents.defaults.imageModel`로 폴백
3. 사용 가능한 인증 기반의 최선 노력 프로바이더 기본값으로 폴백

사용 가능한 모델을 확인할 수 없으면 `pdf` 도구가 노출되지 않습니다.

## 입력 참조

- `pdf` (`string`): 하나의 PDF 경로 또는 URL
- `pdfs` (`string[]`): 여러 PDF 경로 또는 URL, 총 최대 10 개
- `prompt` (`string`): 분석 프롬프트, 기본값 `Analyze this PDF document.`
- `pages` (`string`): `1-5` 또는 `1,3,7-9`와 같은 페이지 필터
- `model` (`string`): 선택적 모델 재정의 (`provider/model`)
- `maxBytesMb` (`number`): PDF 당 크기 상한 (MB)

입력 참고 사항:

- `pdf`와 `pdfs`는 로딩 전에 병합 및 중복 제거됩니다.
- PDF 입력이 제공되지 않으면 도구에서 오류가 발생합니다.
- `pages`는 1 기반 페이지 번호로 파싱되고, 중복 제거, 정렬되며, 구성된 최대 페이지로 클램핑됩니다.
- `maxBytesMb`는 `agents.defaults.pdfMaxBytesMb` 또는 `10`이 기본값입니다.

## 지원되는 PDF 참조

- 로컬 파일 경로 (`~` 확장 포함)
- `file://` URL
- `http://` 및 `https://` URL

참조 참고 사항:

- 다른 URI 스킴 (예: `ftp://`) 은 `unsupported_pdf_reference`로 거부됩니다.
- 샌드박스 모드에서는 원격 `http(s)` URL 이 거부됩니다.
- 워크스페이스 전용 파일 정책이 활성화된 경우 허용된 루트 외부의 로컬 파일 경로가 거부됩니다.

## 실행 모드

### 네이티브 프로바이더 모드

네이티브 모드는 프로바이더 `anthropic` 및 `google`에 사용됩니다.
도구는 원시 PDF 바이트를 프로바이더 API 로 직접 전송합니다.

네이티브 모드 제한:

- `pages`는 지원되지 않습니다. 설정하면 도구가 오류를 반환합니다.

### 추출 폴백 모드

폴백 모드는 네이티브가 아닌 프로바이더에 사용됩니다.

흐름:

1. 선택된 페이지에서 텍스트를 추출합니다 (최대 `agents.defaults.pdfMaxPages`, 기본값 `20`).
2. 추출된 텍스트 길이가 `200`자 미만이면 선택된 페이지를 PNG 이미지로 렌더링하여 포함합니다.
3. 추출된 콘텐츠와 프롬프트를 선택된 모델로 전송합니다.

폴백 세부 사항:

- 페이지 이미지 추출은 `4,000,000` 픽셀 예산을 사용합니다.
- 대상 모델이 이미지 입력을 지원하지 않고 추출 가능한 텍스트가 없으면 도구에서 오류가 발생합니다.
- 추출 폴백에는 `pdfjs-dist` (및 이미지 렌더링을 위한 `@napi-rs/canvas`) 가 필요합니다.

## 구성

```json5
{
  agents: {
    defaults: {
      pdfModel: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5-mini"],
      },
      pdfMaxBytesMb: 10,
      pdfMaxPages: 20,
    },
  },
}
```

전체 필드 세부 사항은 [구성 참조](/gateway/configuration-reference)를 확인하세요.

## 출력 세부 사항

도구는 `content[0].text`에 텍스트를, `details`에 구조화된 메타데이터를 반환합니다.

일반적인 `details` 필드:

- `model`: 확인된 모델 참조 (`provider/model`)
- `native`: 네이티브 프로바이더 모드는 `true`, 폴백은 `false`
- `attempts`: 성공 전에 실패한 폴백 시도

경로 필드:

- 단일 PDF 입력: `details.pdf`
- 다중 PDF 입력: `details.pdfs[]`에 `pdf` 항목
- 샌드박스 경로 재작성 메타데이터 (해당하는 경우): `rewrittenFrom`

## 오류 동작

- PDF 입력 누락: `pdf required: provide a path or URL to a PDF document` 오류 발생
- PDF 가 너무 많음: `details.error = "too_many_pdfs"`로 구조화된 오류 반환
- 지원되지 않는 참조 스킴: `details.error = "unsupported_pdf_reference"` 반환
- `pages`와 함께 네이티브 모드: `pages is not supported with native PDF providers` 오류 발생

## 예시

단일 PDF:

```json
{
  "pdf": "/tmp/report.pdf",
  "prompt": "Summarize this report in 5 bullets"
}
```

다중 PDF:

```json
{
  "pdfs": ["/tmp/q1.pdf", "/tmp/q2.pdf"],
  "prompt": "Compare risks and timeline changes across both documents"
}
```

페이지 필터링된 폴백 모델:

```json
{
  "pdf": "https://example.com/report.pdf",
  "pages": "1-3,7",
  "model": "openai/gpt-5-mini",
  "prompt": "Extract only customer-impacting incidents"
}
```
