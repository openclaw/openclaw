---
summary: "`openclaw skills` (목록/정보/확인) 및 스킬 적격성에 대한 CLI 참조"
read_when:
  - 사용 가능한 스킬 및 실행 준비가 된 스킬을 확인하고 싶습니다
  - 스킬에 대한 누락된 바이너리/환경/설정을 디버그하고 싶습니다
title: "스킬"
---

# `openclaw skills`

스킬을 검사하여 (번들 + 워크스페이스 + 관리된 오버라이드) 적격한지, 필요한 요구사항이 누락되었는지 확인합니다.

관련 항목:

- 스킬 시스템: [스킬](/tools/skills)
- 스킬 설정: [스킬 설정](/tools/skills-config)
- ClawHub 설치: [ClawHub](/tools/clawhub)

## 명령어

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
