---
summary: "`openclaw status`에 대한 CLI 참조 (진단, 프로브, 사용 스냅샷)"
read_when:
  - 채널 상태와 최근 세션 수신자를 빠르게 진단하고 싶을 때
  - 디버깅을 위한 붙여넣기 가능한 “전체” 상태를 원함
title: "상태"
---

# `openclaw status`

채널 + 세션에 대한 진단입니다.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

노트:

- `--deep`는 실시간 프로브 (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal)를 실행합니다.
- 여러 에이전트가 구성된 경우 출력에는 에이전트별 세션 스토어가 포함됩니다.
- 개요에는 사용 가능한 경우 Gateway(게이트웨이) + 노드 호스트 서비스의 설치/런타임 상태가 포함됩니다.
- 개요에는 업데이트 채널 + git SHA (소스 체크아웃용)가 포함됩니다.
- 업데이트 정보는 개요에 표시됩니다. 업데이트가 उपलब्ध한 경우 상태 출력에 `openclaw update`를 실행하라는 힌트가 표시됩니다 ([업데이트](/install/updating) 참조).
