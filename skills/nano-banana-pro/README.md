# 🍌 Nano Banana Pro — Google Imagen 이미지 생성

Google Gemini API의 Imagen 3 모델을 사용한 텍스트-이미지 생성 스킬.

## Quick Start

```powershell
# PowerShell
pwsh scripts/generate-image.ps1 -Prompt "Luxury Korean skincare serum bottle, studio lighting"

# Node.js
node scripts/generate-image.js --prompt "Luxury Korean skincare serum bottle, studio lighting"
```

## API Endpoint

```
POST https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict
Header: x-goog-api-key: <API_KEY>
```

### Request Format

```json
{
  "instances": [{ "prompt": "Your description here" }],
  "parameters": {
    "sampleCount": 4,
    "aspectRatio": "1:1"
  }
}
```

### Response Format

```json
{
  "predictions": [{ "bytesBase64Encoded": "<base64 PNG data>", "mimeType": "image/png" }]
}
```

## 가격 (Pricing)

| 티어                 | 가격         | 비고                           |
| -------------------- | ------------ | ------------------------------ |
| **Free (AI Studio)** | $0           | 분당 요청 제한, 일일 한도 있음 |
| **Standard**         | ~$0.04/image | Imagen 3 기준                  |
| **고해상도**         | ~$0.08/image | 고해상도 옵션                  |

> 가격은 변동될 수 있음. [Google AI 가격표](https://ai.google.dev/pricing) 참조.

## Aspect Ratios

| 비율   | 용도                            |
| ------ | ------------------------------- |
| `1:1`  | 인스타그램, 프로필, 제품 썸네일 |
| `3:4`  | 세로형 제품 사진                |
| `4:3`  | 가로형 배너                     |
| `9:16` | 릴스, TikTok, 스토리            |
| `16:9` | YouTube 썸네일, 와이드 배너     |

## 프로젝트별 프롬프트 예시

### MAIBEAUTY (화장품)

```
"Vietnamese cosmetics product flat lay, white marble background, soft shadows, professional product photography"
"Korean skincare routine products arranged beautifully, pastel background, editorial style"
"Close-up of luxury serum droplet, golden liquid, dark background, high-end advertising"
```

### MAITUTOR (교육)

```
"Cute illustrated character studying with books, Korean style, warm colors, educational"
"Clean infographic illustration about chemistry, modern flat design, pastel colors"
```

### MAICON (마케팅)

```
"Modern minimalist banner for tech startup, gradient background, abstract shapes"
"Social media post template, bold typography placeholder, vibrant Korean design aesthetic"
```

## 제한 사항

- 사람 얼굴/유명인 생성 제한 (Google 안전 정책)
- 폭력적/성적 콘텐츠 차단
- 프롬프트는 영문 권장 (품질 향상)
- 최대 4장 동시 생성
- Free 티어: 분당/일일 요청 제한

## 파일 구조

```
nano-banana-pro/
├── SKILL.md                    # 스킬 설명 (MAIBOT용)
├── README.md                   # 이 파일
└── scripts/
    ├── generate-image.ps1      # PowerShell 스크립트
    └── generate-image.js       # Node.js 스크립트
```
