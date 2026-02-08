---
read_when:
    - 구성/상태에 대해 빠른 보안 감사를 실행하고 싶습니다.
    - 안전한 "수정" 제안을 적용하고 싶습니다(chmod, 기본값 강화).
summary: '`openclaw security`에 대한 CLI 참조(일반적인 보안 풋건 감사 및 수정)'
title: 보안
x-i18n:
    generated_at: "2026-02-08T15:49:23Z"
    model: gtx
    provider: google-translate
    source_hash: 96542b4784e53933cca1613bb4627303bdb4d2e36dda86db66e8580175e81a2f
    source_path: cli/security.md
    workflow: 15
---

# `openclaw security`

보안 도구(감사 + 선택적 수정)

관련된:

- 보안 가이드: [보안](/gateway/security)

## 심사

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

감사에서는 여러 DM 발신자가 기본 세션을 공유할 때 경고하고 다음을 권장합니다. **보안 DM 모드**: `session.dmScope="per-channel-peer"` (또는 `per-account-channel-peer` 다중 계정 채널의 경우) 공유 받은 편지함의 경우.
또한 소형 모델(`<=300B`)은 샌드박싱 없이 웹/브라우저 도구가 활성화된 상태에서 사용됩니다.
