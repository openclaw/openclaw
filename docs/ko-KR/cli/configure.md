---
summary: "`openclaw configure` (대화형 구성 프롬프트)에 대한 CLI 참조"
read_when:
  - 대화형으로 자격 증명, 디바이스 또는 에이전트 기본 설정을 조정하려는 경우
title: "구성"
---

# `openclaw configure`

자격 증명, 디바이스 및 에이전트 기본 설정을 설정하기 위한 대화형 프롬프트입니다.

참고: **모델** 섹션에는 이제 `/model` 및 모델 선택기에 나타나는 `agents.defaults.models` 허용 목록에 대한 멀티 선택이 포함되어 있습니다.

팁: 하위 명령어 없이 `openclaw config`를 사용하면 동일한 마법사가 열립니다. 대화형 편집이 아닐 경우 `openclaw config get|set|unset`을 사용하세요.

관련 항목:

- 게이트웨이 구성 참조: [구성](/gateway/configuration)
- 구성 CLI: [구성](/cli/config)

주의사항:

- 게이트웨이가 실행되는 위치를 선택하면 항상 `gateway.mode`가 업데이트됩니다. 다른 섹션이 필요하지 않다면 "계속"을 선택할 수 있습니다.
- 채널 지향 서비스(Slack/Discord/Matrix/Microsoft Teams)는 설정 중에 채널/룸 허용 목록을 요청합니다. 이름 또는 ID를 입력할 수 있으며, 마법사가 가능한 경우 이름을 ID로 변환합니다.

## 예제

```bash
openclaw configure
openclaw configure --section models --section channels
```
