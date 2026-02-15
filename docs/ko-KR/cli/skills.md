---
summary: "CLI reference for `openclaw skills` (list/info/check) and skill eligibility"
read_when:
  - You want to see which skills are available and ready to run
  - You want to debug missing binaries/env/config for skills
title: "skills"
x-i18n:
  source_hash: 7878442c88a27ec8033f3125c319e9a6a85a1c497a404a06112ad45185c261b0
---

# `openclaw skills`

기술(번들 + 작업 영역 + 관리형 재정의)을 검사하고 적합한 요구 사항과 누락된 요구 사항을 확인하세요.

관련 항목:

- 스킬 시스템: [스킬](/tools/skills)
- 스킬 구성 : [스킬 구성](/tools/skills-config)
- ClawHub 설치: [ClawHub](/tools/clawhub)

## 명령

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
