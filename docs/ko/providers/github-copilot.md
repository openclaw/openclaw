---
read_when:
    - GitHub Copilot을 모델 공급자로 사용하고 싶습니다.
    - '`openclaw models auth login-github-copilot` 흐름이 필요합니다.'
summary: 장치 흐름을 사용하여 OpenClaw에서 GitHub Copilot에 로그인합니다.
title: GitHub 코파일럿
x-i18n:
    generated_at: "2026-02-08T16:09:19Z"
    model: gtx
    provider: google-translate
    source_hash: 503e0496d92c921e2f7111b1b4ba16374f5b781643bfbc6cb69cea97d9395c25
    source_path: providers/github-copilot.md
    workflow: 15
---

# GitHub 코파일럿

## GitHub Copilot이란 무엇입니까?

GitHub Copilot은 GitHub의 AI 코딩 도우미입니다. Copilot에 대한 액세스를 제공합니다.
GitHub 계정 및 계획에 대한 모델. OpenClaw는 Copilot을 모델로 사용할 수 있습니다.
두 가지 다른 방법으로 공급자.

## OpenClaw에서 Copilot을 사용하는 두 가지 방법

### 1) 내장 GitHub Copilot 공급자(`github-copilot`)

기본 장치 로그인 흐름을 사용하여 GitHub 토큰을 얻은 다음 이를 다음과 교환합니다.
OpenClaw가 실행될 때 Copilot API 토큰. 이것은 **기본** 그리고 가장 간단한 경로
VS Code가 필요하지 않기 때문입니다.

### 2) Copilot 프록시 플러그인(`copilot-proxy`)

사용 **부조종사 프록시** VS Code 확장을 로컬 브리지로 사용합니다. OpenClaw는 다음과 대화합니다.
프록시의 `/v1` 엔드포인트에서 구성한 모델 목록을 사용합니다. 선택
이미 VS Code에서 Copilot Proxy를 실행했거나 이를 통해 라우팅해야 하는 경우입니다.
플러그인을 활성화하고 VS Code 확장을 계속 실행해야 합니다.

GitHub Copilot을 모델 공급자로 사용(`github-copilot`). 로그인 명령이 실행됩니다.
GitHub 장치 흐름을 사용하고, 인증 프로필을 저장하고, 이를 사용하도록 구성을 업데이트합니다.
프로필.

## CLI 설정

```bash
openclaw models auth login-github-copilot
```

URL을 방문하여 일회성 코드를 입력하라는 메시지가 표시됩니다. 터미널을 유지하세요
완료될 때까지 열려 있습니다.

### 선택적 플래그

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## 기본 모델 설정

```bash
openclaw models set github-copilot/gpt-4o
```

### 구성 스니펫

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## 메모

- 대화형 TTY가 필요합니다. 터미널에서 직접 실행하세요.
- Copilot 모델 가용성은 계획에 따라 다릅니다. 모델이 거부되면 시도해 보세요.
  다른 ID(예: `github-copilot/gpt-4.1`).
- 로그인은 인증 프로필 저장소에 GitHub 토큰을 저장하고 이를
  OpenClaw가 실행될 때 Copilot API 토큰.
