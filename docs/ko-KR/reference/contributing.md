---
summary: "OpenClaw 개발 및 기여 가이드"
read_when:
  - 프로젝트에 기여하고 싶을 때
  - 소스에서 빌드할 때
title: "개발 가이드"
---

# 개발 가이드

이 문서는 OpenClaw 프로젝트에 기여하거나 소스에서 빌드하려는 개발자를 위한 가이드입니다.

## 개발 환경 설정

### 요구사항

| 항목              | 요구사항      |
| ----------------- | ------------- |
| **Node.js**       | v22.12.0 이상 |
| **패키지 매니저** | pnpm (권장)   |
| **Git**           | 최신 버전     |

### 저장소 클론

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

### 의존성 설치

```bash
pnpm install
```

### 빌드

```bash
pnpm build
```

### 개발 서버 실행

```bash
pnpm dev
```

## 프로젝트 구조

```
openclaw/
├── src/                    # 메인 소스 코드
│   ├── agent/              # 에이전트 로직
│   ├── channels/           # 채널 구현
│   │   ├── discord/
│   │   ├── slack/
│   │   ├── telegram/
│   │   └── whatsapp/
│   ├── cli/                # CLI 명령어
│   ├── gateway/            # Gateway 서버
│   ├── tools/              # 에이전트 도구
│   └── web/                # 웹 UI
├── docs/                   # 문서
├── scripts/                # 빌드/유틸리티 스크립트
├── tests/                  # 테스트
└── package.json
```

## 주요 스크립트

| 스크립트         | 설명                 |
| ---------------- | -------------------- |
| `pnpm build`     | 프로덕션 빌드        |
| `pnpm dev`       | 개발 모드 실행       |
| `pnpm test`      | 테스트 실행          |
| `pnpm lint`      | 린트 검사 (oxlint)   |
| `pnpm format`    | 코드 포맷팅 (oxfmt)  |
| `pnpm typecheck` | TypeScript 타입 검사 |

## 기여 가이드라인

### 기여 방법

1. **버그 및 작은 수정** → PR을 직접 열어주세요!
2. **새 기능 / 아키텍처 변경** → 먼저 [GitHub Discussion](https://github.com/openclaw/openclaw/discussions)이나 Discord에서 논의
3. **질문** → Discord #setup-help 채널

### PR 제출 전 체크리스트

- [ ] 로컬에서 OpenClaw 인스턴스로 테스트
- [ ] 테스트 실행: `pnpm build && pnpm check && pnpm test`
- [ ] PR은 하나의 목적에 집중 (한 PR에 한 가지)
- [ ] 무엇을, 왜 변경했는지 설명

### 코드 스타일

프로젝트는 다음 도구를 사용합니다:

- **oxlint**: 린팅
- **oxfmt**: 포맷팅
- **TypeScript**: 타입 검사

커밋 전에 항상 실행:

```bash
pnpm lint
pnpm format
pnpm typecheck
```

### 커밋 메시지

명확하고 설명적인 커밋 메시지를 작성하세요:

```
feat(telegram): 스티커 검색 기능 추가

- 캐시된 스티커를 설명으로 검색하는 기능 구현
- fuzzy matching 지원
- 검색 결과 제한 옵션 추가
```

## 테스트

### 단위 테스트 실행

```bash
pnpm test
```

### 특정 테스트 실행

```bash
pnpm test -- --grep "telegram"
```

### 테스트 커버리지

```bash
pnpm test:coverage
```

## 문서 개발

### 로컬에서 문서 서버 실행

```bash
cd docs
mintlify dev
```

### 문서 구조

```
docs/
├── index.md                # 메인 페이지
├── start/                  # 시작하기 가이드
├── channels/               # 채널별 문서
├── gateway/                # Gateway 설정
├── concepts/               # 개념 설명
├── tools/                  # 도구 문서
└── ko-KR/                  # 한국어 문서
```

## 디버깅

### 상세 모드로 Gateway 실행

```bash
openclaw gateway --verbose
```

### 로그 확인

```bash
openclaw logs --follow
```

### 디버그 로깅 활성화

```json5
{
  logging: {
    level: "debug",
  },
}
```

## 릴리스 채널

| 채널       | 설명             | npm 태그 |
| ---------- | ---------------- | -------- |
| **stable** | 정식 릴리스      | `latest` |
| **beta**   | 프리릴리스       | `beta`   |
| **dev**    | main 브랜치 최신 | `dev`    |

### 채널 전환

```bash
openclaw update --channel <stable|beta|dev>
```

## 주요 메인테이너

- [@AviCraworker](https://github.com/AviCraworker)
- [@AstraSpliff](https://github.com/AstraSpliff) (Slack/Groups)
- [@DotSlashAnas](https://github.com/DotSlashAnas) (Linux, Docker)
- [@ChessSharp](https://github.com/ChessSharp) (Tailscale, Windows)

## 도움 받기

- [GitHub Issues](https://github.com/openclaw/openclaw/issues)
- [Discord 커뮤니티](https://discord.gg/clawd)
- [GitHub Discussions](https://github.com/openclaw/openclaw/discussions)
