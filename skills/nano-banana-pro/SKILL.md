# Nano Banana Pro — Google Imagen 이미지 생성 스킬

## 언제 사용하나요?

사용자가 다음을 요청할 때 이 스킬을 사용합니다:

- 이미지 생성/만들기 (generate image, create image, 그림 그려줘, 이미지 만들어줘)
- 제품 사진 생성 (product photography)
- 마케팅 이미지, 배너, 썸네일 생성
- 교육용 일러스트레이션

## 사용 방법

### PowerShell (기본)

```powershell
pwsh C:\MAIBOT\skills\nano-banana-pro\scripts\generate-image.ps1 `
  -Prompt "A Korean cosmetics product on a marble table, soft lighting" `
  -OutputDir "C:\TEST\generated-images" `
  -Count 1 `
  -AspectRatio "1:1"
```

### Node.js (대안)

```bash
node C:\MAIBOT\skills\nano-banana-pro\scripts\generate-image.js \
  --prompt "A Korean cosmetics product on a marble table" \
  --output "C:\TEST\generated-images" \
  --count 1 \
  --aspect-ratio "1:1"
```

## 파라미터

| 파라미터    | 필수 | 기본값                     | 설명                                      |
| ----------- | ---- | -------------------------- | ----------------------------------------- |
| prompt      | ✅   | —                          | 영문 프롬프트 권장 (한글도 가능)          |
| outputDir   | —    | `C:\TEST\generated-images` | 저장 경로                                 |
| count       | —    | 1                          | 생성할 이미지 수 (1-4)                    |
| aspectRatio | —    | `1:1`                      | 비율: `1:1`, `3:4`, `4:3`, `9:16`, `16:9` |

## 지원 모델

- **imagen-3.0-generate-002** (기본) — 고품질 이미지 생성
- **imagen-4.0-generate-001** — 최신 모델 (가용 시)

## 프로젝트별 활용

- **MAIBEAUTY**: 제품 사진, 리뷰 이미지, 마케팅 배너
- **MAITUTOR**: 교육 콘텐츠 일러스트
- **MAICON**: 마케팅/광고 이미지

## 주의사항

- API 키는 `~/.openclaw/openclaw.json` → `models.providers.google.apiKey`에서 자동 로드
- 사람 얼굴 생성은 Google 정책에 의해 제한될 수 있음
- 프롬프트는 영문이 품질이 더 좋음
- 무료 티어: 분당 요청 제한 있음
