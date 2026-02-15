---
summary: "CLI reference for `openclaw security` (audit and fix common security footguns)"
read_when:
  - You want to run a quick security audit on config/state
  - You want to apply safe “fix” suggestions (chmod, tighten defaults)
title: "security"
x-i18n:
  source_hash: f8f89683132bf2431575cd30f0e8fa39d7fda52e0bf36c21a6d46b08d82e9fdb
---

# `openclaw security`

보안 도구(감사 + 선택적 수정)

관련 항목:

- 보안 가이드 : [보안](/gateway/security)

## 감사

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

감사에서는 여러 DM 발신자가 기본 세션을 공유할 때 경고하고 공유 받은 편지함에 대해 **보안 DM 모드**: `session.dmScope="per-channel-peer"`(또는 다중 계정 채널의 경우 `per-account-channel-peer`)를 권장합니다.
또한 작은 모델(`<=300B`)이 샌드박스 없이 사용되거나 웹/브라우저 도구가 활성화된 경우에도 경고합니다.
웹훅 인그레스의 경우 `hooks.defaultSessionKey`가 설정되지 않은 경우, 요청 `sessionKey` 재정의가 활성화된 경우, `hooks.allowedSessionKeyPrefixes` 없이 재정의가 활성화된 경우 경고합니다.
