---
summary: "`openclaw skills` CLI 레퍼런스 (list/info/check) 및 Skills 자격 확인"
read_when:
  - 어떤 Skills이 사용 가능하고 실행 준비가 되었는지 확인하고 싶을 때
  - Skills의 누락된 바이너리/환경변수/설정을 디버깅할 때
title: "skills"
x-i18n:
  source_path: "docs/cli/skills.md"
---

# `openclaw skills`

Skills (번들 + 워크스페이스 + 관리형 오버라이드)을 검사하고 자격 충족 여부와 누락된 요구사항을 확인합니다.

관련 문서:

- Skills 시스템: [Skills](/tools/skills)
- Skills 설정: [Skills config](/tools/skills-config)
- ClawHub 설치: [ClawHub](/tools/clawhub)

## 명령어

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
