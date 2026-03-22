---
summary: "`openclaw status` CLI 레퍼런스 (진단, 프로브, 사용량 스냅샷)"
read_when:
  - 채널 상태 + 최근 세션 수신자를 빠르게 진단하고 싶을 때
  - 디버깅용 복사 가능한 전체 상태 정보가 필요할 때
title: "status"
x-i18n:
  source_path: "docs/cli/status.md"
---

# `openclaw status`

채널 + 세션 진단입니다.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

참고:

- `--deep`은 라이브 프로브를 실행합니다 (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- 여러 에이전트가 설정된 경우 에이전트별 세션 저장소가 출력에 포함됩니다.
- 개요에는 가용할 경우 Gateway + 노드 호스트 서비스 설치/런타임 상태가 포함됩니다.
- 개요에는 업데이트 채널 + git SHA (소스 체크아웃의 경우)가 포함됩니다.
- 업데이트 정보는 개요에 표시됩니다. 업데이트가 가능한 경우, status는 `openclaw update` 실행을 안내하는 힌트를 출력합니다 ([Updating](/install/updating) 참조).
- 읽기 전용 상태 화면 (`status`, `status --json`, `status --all`)은 가능한 경우 대상 설정 경로에 대해 지원되는 SecretRef를 해석합니다.
- 지원되는 채널 SecretRef가 설정되었지만 현재 명령 경로에서 사용할 수 없는 경우, status는 읽기 전용을 유지하며 크래시 대신 저하된 출력을 보고합니다. 사람이 읽는 출력에는 "configured token unavailable in this command path"와 같은 경고가 표시되고, JSON 출력에는 `secretDiagnostics`가 포함됩니다.
- 명령 로컬 SecretRef 해석이 성공하면, status는 해석된 스냅샷을 우선 사용하고 최종 출력에서 일시적인 "secret unavailable" 채널 마커를 제거합니다.
- `status --all`에는 Secrets 개요 행과 시크릿 진단을 요약하는 진단 섹션이 포함됩니다 (가독성을 위해 잘림). 보고서 생성은 중단되지 않습니다.
