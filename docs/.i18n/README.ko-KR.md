# OpenClaw 한국어 문서 번역 가이드

## 개요

한국어 문서는 `docs/ko-KR/` 디렉토리에 위치하며, 영문 문서(`docs/`)를 기반으로 생성됩니다.

## 파일 구조

- `glossary.ko-KR.json` — 용어 매핑 (번역 가이드로 사용)
- `ko-KR.tm.jsonl` — 번역 메모리 (캐시)

## 번역 워크플로우

1. 영문 문서 업데이트
2. 필요시 용어집(`glossary.ko-KR.json`) 조정
3. `scripts/docs-i18n` 실행하여 번역 생성
4. 필요한 경우에만 수동 수정 적용

## 번역 명령어

### 기본 사용법

```bash
cd scripts/docs-i18n
go run . -lang ko-KR -src en -docs ../../docs [파일 목록]
```

### 예제

단일 파일 번역:
```bash
go run . -lang ko-KR -docs ../../docs ../../docs/index.md
```

여러 파일 번역:
```bash
go run . -lang ko-KR -docs ../../docs ../../docs/index.md ../../docs/start/getting-started.md
```

전체 문서 번역 (doc mode):
```bash
go run . -lang ko-KR -mode doc -parallel 4 -docs ../../docs $(find ../../docs -name "*.md" -not -path "*/zh-CN/*" -not -path "*/ko-KR/*")
```

### 주요 옵션

- `-lang ko-KR`: 대상 언어 (한국어)
- `-src en`: 원본 언어 (영어)
- `-mode segment|doc`: 번역 모드
  - `segment`: 세그먼트 단위 번역 (기본값, 번역 메모리 사용)
  - `doc`: 문서 단위 번역 (더 빠르지만 메모리 미사용)
- `-thinking low|high`: AI 사고 수준
- `-overwrite`: 기존 번역 덮어쓰기
- `-parallel N`: 병렬 워커 수 (doc mode에서만)
- `-max N`: 처리할 최대 파일 수

## 용어집 관리

`glossary.ko-KR.json` 파일에서 일관된 용어 번역을 관리합니다:

```json
{
  "source": "Gateway",
  "target": "게이트웨이"
}
```

### 주요 용어

- OpenClaw → OpenClaw (제품명은 번역하지 않음)
- Gateway → 게이트웨이
- Skills → 스킬
- Agent → 에이전트
- Channel → 채널
- Session → 세션
- Provider → 프로바이더
- Model → 모델
- CLI → CLI (약어는 번역하지 않음)

## 문서 추가하기

1. 새 페이지를 `docs/ko-KR/` 디렉토리에 추가
2. `docs/docs.json`의 한국어 섹션에 페이지 경로 추가:

```json
{
  "language": "ko",
  "tabs": [
    {
      "tab": "Get started",
      "groups": [
        {
          "group": "Overview",
          "pages": ["ko-KR/index", "ko-KR/start/getting-started"]
        }
      ]
    }
  ]
}
```

## 주의사항

- `docs/ko-KR/**` 파일은 생성된 파일입니다
- 명시적으로 요청받지 않는 한 편집하지 마세요
- 번역 파이프라인이 느리거나 비효율적인 경우, Discord에서 @jospalmbier에게 문의하세요
- 내부 문서 링크: 루트 상대 경로 사용, `.md`/`.mdx` 제외 (예: `[설정](/configuration)`)
- Mintlify 앵커 링크 호환성을 위해 제목에 em dash와 apostrophe 사용 지양

## 번역 메모리

번역 메모리(`ko-KR.tm.jsonl`)는 자동으로 생성되며 워크플로우 + 모델 + 텍스트 해시로 키가 지정됩니다. 이 파일을 직접 편집하지 마세요.
