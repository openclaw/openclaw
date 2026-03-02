---
summary: "디바이스 흐름을 사용하여 OpenClaw에서 GitHub Copilot로 로그인합니다"
read_when:
  - GitHub Copilot을 모델 제공자로 사용하고 싶을 때
  - `openclaw models auth login-github-copilot` 흐름이 필요할 때
title: "GitHub Copilot"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/github-copilot.md"
  workflow: 15
---

# GitHub Copilot

## GitHub Copilot이란?

GitHub Copilot은 GitHub의 AI 코딩 어시스턴트입니다. GitHub 계정 및 계획에 대해 Copilot 모델에 대한 액세스를 제공합니다. OpenClaw는 두 가지 다른 방식으로 Copilot을 모델 제공자로 사용할 수 있습니다.

## OpenClaw에서 Copilot을 사용하는 두 가지 방법

### 1) 기본 제공 GitHub Copilot 제공자 (`github-copilot`)

네이티브 디바이스 로그인 흐름을 사용하여 GitHub 토큰을 가져온 다음 OpenClaw가 실행될 때 Copilot API 토큰으로 교환합니다. 이는 VS Code가 필요하지 않기 때문에 **기본** 및 가장 간단한 경로입니다.

### 2) Copilot 프록시 플러그인 (`copilot-proxy`)

**Copilot Proxy** VS Code 확장을 로컬 브리지로 사용합니다. OpenClaw는 프록시의 `/v1` 엔드포인트와 대화하고 거기에서 구성한 모델 목록을 사용합니다. 이미 VS Code에서 Copilot 프록시를 실행하거나 이를 통해 라우팅해야 할 때 선택합니다.
플러그인을 활성화하고 VS Code 확장을 계속 실행해야 합니다.

모델 제공자 (`github-copilot`)로 GitHub Copilot을 사용합니다. 로그인 명령은 GitHub 디바이스 흐름을 실행하고, 인증 프로필을 저장하고, 구성을 업데이트하여 해당 프로필을 사용합니다.

## CLI 설정

```bash
openclaw models auth login-github-copilot
```

URL을 방문하고 일회용 코드를 입력하라는 메시지가 표시됩니다. 터미널을 열린 상태로 유지하세요.

### 선택 플래그

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

## 참고

- 대화형 TTY가 필요합니다. 터미널에서 직접 실행하세요.
- Copilot 모델 가용성은 계획에 따라 다릅니다. 모델이 거부되면 다른 ID를 시도하세요 (예: `github-copilot/gpt-4.1`).
- 로그인은 GitHub 토큰을 인증 프로필 저장소에 저장하고 OpenClaw가 실행될 때 Copilot API 토큰으로 교환합니다.
