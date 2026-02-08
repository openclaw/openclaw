---
summary: "문제 대응 및 지원 받기"
read_when:
  - 도움이 필요할 때
title: "지원"
---

# 지원

문제 발생 시 지원 받는 방법입니다.

## 자가 진단

### Doctor 실행

```bash
openclaw doctor
```

### 로그 확인

```bash
openclaw logs
openclaw logs --level error
```

### 상태 확인

```bash
openclaw gateway status
openclaw channels status
```

## 문제 보고

### 정보 수집

```bash
# 진단 정보 수집
openclaw doctor --json > diagnostic.json

# 로그 내보내기
openclaw logs --export > logs.txt
```

### GitHub Issues

1. [GitHub Issues](https://github.com/openclaw/openclaw/issues) 방문
2. 기존 이슈 검색
3. 새 이슈 생성
4. 진단 정보 첨부

### 이슈 템플릿

```markdown
**환경**

- OS: macOS 14.0 / Windows 11 / Ubuntu 22.04
- Node.js: v22.12.0
- OpenClaw: 2024.2.0

**재현 단계**

1. ...
2. ...

**예상 동작**
...

**실제 동작**
...

**로그**
(관련 로그 첨부)
```

## 커뮤니티

### Discord

[OpenClaw Discord](https://discord.gg/openclaw)

- #help - 질문 및 도움
- #bugs - 버그 보고
- #feature-requests - 기능 요청

### 문서

- [공식 문서](https://docs.openclaw.ai)
- [API 레퍼런스](https://docs.openclaw.ai/api)

## FAQ

### 자주 묻는 질문

[FAQ 문서](./faq.md) 참조

### 문제 해결 가이드

[문제 해결 가이드](./troubleshooting.md) 참조

## 긴급 문제

### 보안 취약점

보안 문제 발견 시:

- GitHub Issues에 공개하지 마세요
- security@openclaw.ai로 이메일

### 서비스 중단

1. 로그 백업
2. 설정 백업
3. GitHub Issues에 보고

## 기여

### 버그 수정

1. Issue 먼저 생성
2. Fork 및 브랜치 생성
3. 수정 및 테스트
4. Pull Request 제출

### 기능 추가

1. Discussion에서 논의
2. 구현 계획 공유
3. 구현 및 테스트
4. PR 제출

## 로드맵

[GitHub Projects](https://github.com/openclaw/openclaw/projects) 확인
