---
summary: "CLI reference for `openclaw status` (diagnostics, probes, usage snapshots)"
read_when:
  - You want a quick diagnosis of channel health + recent session recipients
  - You want a pasteable “all” status for debugging
title: "status"
x-i18n:
  source_hash: 2bbf5579c48034fc15c2cbd5506c50456230b17e4a74c06318968c590d8f1501
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

- `--deep`는 라이브 프로브(WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal)를 실행합니다.
- 여러 에이전트가 구성된 경우 출력에는 에이전트별 세션 저장소가 포함됩니다.
- 개요에는 가능한 경우 게이트웨이 + 노드 호스트 서비스 설치/런타임 상태가 포함됩니다.
- 개요에는 업데이트 채널 + git SHA(소스 체크아웃용)가 포함됩니다.
- 개요에서 정보 표면을 업데이트합니다. 업데이트가 가능한 경우 status는 `openclaw update`를 실행하라는 힌트를 인쇄합니다([업데이트](/install/updating) 참조).
