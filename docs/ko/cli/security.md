---
summary: "`openclaw security`에 대한 CLI 참조(일반적인 보안 함정 감사 및 수정)"
read_when:
  - 구성/상태에 대해 빠른 보안 감사를 실행하고자 할 때
  - 안전한 “수정” 제안(chmod, 기본값 강화)을 적용하고자 할 때
title: "security"
---

# `openclaw security`

보안 도구(감사 + 선택적 수정).

관련 문서:

- 보안 가이드: [Security](/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

감사는 여러 다이렉트 메시지 발신자가 메인 세션을 공유하는 경우 경고하며, 공유된 수신함에 대해 **보안 다이렉트 메시지 모드**: `session.dmScope="per-channel-peer"` (또는 다중 계정 채널의 경우 `per-account-channel-peer`)를 권장합니다.
또한 작은 모델(`<=300B`)이 샌드박스화 없이 웹/브라우저 도구가 활성화된 상태로 사용되는 경우에도 경고합니다.
