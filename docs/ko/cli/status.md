---
read_when:
    - 채널 상태 + 최근 세션 수신자에 대한 빠른 진단을 원합니다.
    - 디버깅을 위해 붙여넣을 수 있는 "모두" 상태를 원합니다.
summary: '`openclaw status`에 대한 CLI 참조(진단, 프로브, 사용량 스냅샷)'
title: 상태
x-i18n:
    generated_at: "2026-02-08T15:49:53Z"
    model: gtx
    provider: google-translate
    source_hash: 2bbf5579c48034fc15c2cbd5506c50456230b17e4a74c06318968c590d8f1501
    source_path: cli/status.md
    workflow: 15
---

# `openclaw status`

채널 + 세션 진단.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

참고:

- `--deep` 라이브 프로브(WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal)를 실행합니다.
- 여러 에이전트가 구성된 경우 출력에는 에이전트별 세션 저장소가 포함됩니다.
- 개요에는 가능한 경우 게이트웨이 + 노드 호스트 서비스 설치/런타임 상태가 포함됩니다.
- 개요에는 업데이트 채널 + git SHA(소스 체크아웃용)가 포함됩니다.
- 개요에서 정보 표면을 업데이트합니다. 업데이트가 가능한 경우 상태는 실행 힌트를 인쇄합니다. `openclaw update` (보다 [업데이트 중](/install/updating)).
