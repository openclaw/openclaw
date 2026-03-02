---
summary: "대화형 구성 프롬프트를 위한 CLI 참조"
read_when:
  - 대화형으로 자격 증명, 장치 또는 에이전트 기본값을 조정하려고 할 때
title: "configure"
---

# `openclaw configure`

자격 증명, 장치 및 에이전트 기본값을 설정하기 위한 대화형 프롬프트입니다.

참고: **Model** 섹션은 이제 `agents.defaults.models` 허용 목록 (어떤 것이 `/model` 및 모델 선택기에 표시되는지) 을 위한 다중 선택을 포함합니다.

팁: 하위 명령 없이 `openclaw config` 를 실행하면 동일한 마법사를 엽니다. 비대화형 편집을 위해 `openclaw config get|set|unset` 을 사용합니다.

관련 사항:

- Gateway 구성 참조: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

참고:

- Gateway 가 실행되는 위치를 선택하면 항상 `gateway.mode` 를 업데이트합니다. 이것이 필요한 모든 것이면 다른 섹션 없이 "Continue" 를 선택할 수 있습니다.
- 채널 지향 서비스 (Slack/Discord/Matrix/Microsoft Teams) 는 설정 중에 채널/room 허용 목록에 대한 프롬프트를 수행합니다. 이름 또는 ID 를 입력할 수 있습니다. 마법사는 가능할 때 이름을 ID 로 해결합니다.

## 예시

```bash
openclaw configure
openclaw configure --section model --section channels
```

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/configure.md
workflow: 15
