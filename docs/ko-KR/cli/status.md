---
summary: "`openclaw status`에 대한 CLI 참조 (진단, 프로브, 사용 스냅샷)"
read_when:
  - 채널 상태와 최근 세션 수신자의 빠른 진단을 원할 때
  - 디버깅을 위한 붙여넣기 가능한 “모든” 상태를 원할 때
title: "상태"
---

# `openclaw status`

채널 + 세션에 대한 진단.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

주의사항:

- `--deep` 옵션은 실시간 프로브를 실행합니다 (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- 여러 에이전트가 설정된 경우 에이전트별 세션 저장소가 출력에 포함됩니다.
- 게이트웨이 + 노드 호스트 서비스 설치/실행 상태가 가능할 경우 개요에 포함됩니다.
- 개요에는 업데이트 채널 + git SHA (소스 체크아웃용)가 포함됩니다.
- 업데이트 정보는 개요에 표시되고, 업데이트가 가능하면 상태는 `openclaw update`를 실행하라는 힌트를 출력합니다 (자세한 내용은 [업데이트](/install/updating)를 참조하십시오).
