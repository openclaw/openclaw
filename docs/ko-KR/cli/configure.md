---
summary: "`openclaw configure` CLI 레퍼런스 (대화형 설정 프롬프트)"
read_when:
  - 자격 증명, 디바이스 또는 에이전트 기본값을 대화형으로 조정하고 싶을 때
title: "configure"
x-i18n:
  source_path: "docs/cli/configure.md"
---

# `openclaw configure`

자격 증명, 디바이스 및 에이전트 기본값을 설정하는 대화형 프롬프트입니다.

참고: **Model** 섹션에는 이제 `agents.defaults.models` 허용 목록 (모델 선택기 및 `/model`에 표시되는 항목)을 위한 다중 선택이 포함되어 있습니다.

팁: 하위 명령 없이 `openclaw config`를 실행하면 동일한 마법사가 열립니다. 비대화형 편집에는 `openclaw config get|set|unset`을 사용하세요.

관련 문서:

- Gateway 설정 레퍼런스: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

참고:

- Gateway가 실행될 위치를 선택하면 항상 `gateway.mode`가 업데이트됩니다. 그것만 필요한 경우 다른 섹션 없이 "Continue"를 선택할 수 있습니다.
- 채널 지향 서비스 (Slack/Discord/Matrix/Microsoft Teams)는 설정 중 채널/룸 허용 목록을 묻습니다. 이름이나 ID를 입력할 수 있으며, 마법사가 가능한 경우 이름을 ID로 변환합니다.
- 데몬 설치 단계를 실행할 때 토큰 인증에 토큰이 필요하고 `gateway.auth.token`이 SecretRef로 관리되는 경우, configure는 SecretRef를 검증하지만 해석된 평문 토큰 값을 슈퍼바이저 서비스 환경 메타데이터에 저장하지 않습니다.
- 토큰 인증에 토큰이 필요하고 설정된 토큰 SecretRef가 해석되지 않는 경우, configure는 실행 가능한 해결 안내와 함께 데몬 설치를 차단합니다.
- `gateway.auth.token`과 `gateway.auth.password`가 모두 설정되어 있고 `gateway.auth.mode`가 설정되지 않은 경우, mode가 명시적으로 설정될 때까지 configure는 데몬 설치를 차단합니다.

## 예시

```bash
openclaw configure
openclaw configure --section model --section channels
```
