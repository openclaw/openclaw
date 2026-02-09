---
summary: "`openclaw voicecall`에 대한 CLI 참조 (음성 통화 플러그인 명령 인터페이스)"
read_when:
  - 음성 통화 플러그인을 사용하며 CLI 진입점이 필요할 때
  - "`voicecall call|continue|status|tail|expose`에 대한 빠른 예제가 필요할 때"
title: "voicecall"
---

# `openclaw voicecall`

`voicecall`는 플러그인에서 제공하는 명령입니다. 음성 통화 플러그인이 설치되고 활성화된 경우에만 표시됩니다.

주 문서:

- 음성 통화 플러그인: [Voice Call](/plugins/voice-call)

## 공통 명령

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## 웹훅 노출 (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

보안 참고 사항: 신뢰하는 네트워크에만 웹훅 엔드포인트를 노출하십시오. 가능하면 Funnel 대신 Tailscale Serve 사용을 권장합니다.
