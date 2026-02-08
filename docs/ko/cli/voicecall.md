---
read_when:
    - 음성 통화 플러그인을 사용하고 CLI 진입점을 원합니다.
    - '`voicecall call|continue|status|tail|expose`에 대한 빠른 예를 원합니다.'
summary: '`openclaw voicecall`에 대한 CLI 참조(음성 통화 플러그인 명령 표면)'
title: 음성통화
x-i18n:
    generated_at: "2026-02-08T15:53:47Z"
    model: gtx
    provider: google-translate
    source_hash: d93aaee6f6f5c9ac468d8d2905cb23f0f2db75809408cb305c055505be9936f2
    source_path: cli/voicecall.md
    workflow: 15
---

# `openclaw voicecall`

`voicecall` 플러그인 제공 명령입니다. 음성 통화 플러그인이 설치되어 활성화된 경우에만 나타납니다.

기본 문서:

- 음성 통화 플러그인: [음성통화](/plugins/voice-call)

## 일반적인 명령

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## 웹훅 노출(Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

보안 참고 사항: 신뢰할 수 있는 네트워크에만 웹훅 엔드포인트를 노출하세요. 가능하면 깔때기보다 Tailscale Serving을 선호하세요.
