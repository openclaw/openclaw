---
read_when:
    - 자격 증명, 장치 또는 에이전트 기본값을 대화형으로 조정하려는 경우
summary: '`openclaw configure`에 대한 CLI 참조(대화형 구성 프롬프트)'
title: 구성
x-i18n:
    generated_at: "2026-02-08T15:52:23Z"
    model: gtx
    provider: google-translate
    source_hash: 9cb2bb5237b02b3a2dca71b5e43b11bd6b9939b9e4aa9ce1882457464b51efd2
    source_path: cli/configure.md
    workflow: 15
---

# `openclaw configure`

자격 증명, 장치 및 에이전트 기본값을 설정하는 대화형 프롬프트입니다.

참고: **모델** 이제 섹션에 다중 선택이 포함됩니다.
`agents.defaults.models` 허용 목록(다음에 표시되는 내용 `/model` 및 모델 선택기).

팁: `openclaw config` 하위 명령이 없으면 동일한 마법사가 열립니다. 사용
`openclaw config get|set|unset` 비대화형 편집의 경우.

관련된:

- 게이트웨이 구성 참조: [구성](/gateway/configuration)
- 구성 CLI: [구성](/cli/config)

참고:

- 게이트웨이가 실행되는 위치를 선택하면 항상 업데이트됩니다. `gateway.mode`. 필요한 경우 다른 섹션 없이 "계속"을 선택할 수 있습니다.
- 채널 지향 서비스(Slack/Discord/Matrix/Microsoft Teams)는 설정 중에 채널/룸 허용 목록을 묻는 메시지를 표시합니다. 이름이나 ID를 입력할 수 있습니다. 마법사는 가능한 경우 이름을 ID로 확인합니다.

## 예

```bash
openclaw configure
openclaw configure --section models --section channels
```
