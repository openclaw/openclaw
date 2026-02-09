---
summary: "`openclaw skills`(list/info/check)에 대한 CLI 참조 및 스킬 적격성"
read_when:
  - 사용 가능한 스킬과 실행 준비 상태를 확인하고 싶을 때
  - 스킬에 필요한 바이너리/환경 변수/구성이 누락되었는지 디버그하고 싶을 때
title: "skills"
---

# `openclaw skills`

스킬(번들 + 워크스페이스 + 관리형 오버라이드)을 검사하고, 적격 여부와 요구 사항 누락을 확인합니다.

관련 항목:

- Skills 시스템: [Skills](/tools/skills)
- Skills 설정: [Skills config](/tools/skills-config)
- ClawHub 설치: [ClawHub](/tools/clawhub)

## Commands

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
