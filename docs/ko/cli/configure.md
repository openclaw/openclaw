---
summary: "`openclaw configure`를 위한 CLI 참조 (대화형 구성 프롬프트)"
read_when:
  - 자격 증명, 디바이스 또는 에이전트 기본값을 대화형으로 조정하려는 경우
title: "configure"
---

# `openclaw configure`

자격 증명, 디바이스 및 에이전트 기본값을 설정하기 위한 대화형 프롬프트입니다.

참고: **모델** 섹션에는 이제
`agents.defaults.models` 허용 목록에 대한 다중 선택이 포함됩니다(`/model` 및 모델 선택기에 표시되는 항목).

팁: 하위 명령 없이 `openclaw config`를 실행하면 동일한 마법사가 열립니다. 비대화형 편집에는
`openclaw config get|set|unset`를 사용하십시오.

관련:

- Gateway(게이트웨이) 구성 참조: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

참고 사항:

- Gateway(게이트웨이) 실행 위치를 선택하면 항상 `gateway.mode`가 업데이트됩니다. 그것만 필요하다면 다른 섹션 없이 "계속"을 선택할 수 있습니다.
- 채널 중심 서비스(Slack/Discord/Matrix/Microsoft Teams)는 설정 중 채널/룸 허용 목록을 요청합니다. 이름 또는 ID를 입력할 수 있으며, 마법사는 가능한 경우 이름을 ID로 해석합니다.

## 예제

```bash
openclaw configure
openclaw configure --section models --section channels
```
