---
summary: "`openclaw agent` CLI 레퍼런스 (Gateway를 통해 에이전트 턴 하나 실행)"
read_when:
  - 스크립트에서 에이전트 턴 하나를 실행하고 싶을 때 (선택적으로 응답 전달)
title: "agent"
x-i18n:
  source_path: "docs/cli/agent.md"
---

# `openclaw agent`

Gateway를 통해 에이전트 턴을 실행합니다 (임베디드 모드는 `--local` 사용).
`--agent <id>`를 사용하여 설정된 에이전트를 직접 지정할 수 있습니다.

관련 문서:

- 에이전트 전송 도구: [Agent send](/tools/agent-send)

## 예시

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## 참고

- 이 명령이 `models.json` 재생성을 트리거할 때, SecretRef로 관리되는 프로바이더 자격 증명은 해석된 시크릿 평문이 아닌 비밀이 아닌 마커(예: 환경 변수 이름, `secretref-env:ENV_VAR_NAME`, 또는 `secretref-managed`)로 저장됩니다.
- 마커 기록은 소스 권한적입니다: OpenClaw는 해석된 런타임 시크릿 값이 아닌 활성 소스 설정 스냅샷의 마커를 저장합니다.
