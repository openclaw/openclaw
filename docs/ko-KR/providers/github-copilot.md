---
summary: "OpenClaw에서 기기 플로우를 사용하여 GitHub Copilot에 로그인"
read_when:
  - GitHub Copilot을 모델 프로바이더로 사용하려는 경우
  - "`openclaw models auth login-github-copilot` 플로우가 필요한 경우"
title: "GitHub Copilot"
---

# GitHub Copilot

## GitHub Copilot이란 무엇인가요?

GitHub Copilot은 GitHub의 AI 코딩 어시스턴트입니다. 이것은 여러분의 GitHub 계정과 계획에 대한 Copilot 모델 액세스를 제공합니다. OpenClaw는 두 가지 다른 방법으로 Copilot을 모델 프로바이더로 사용할 수 있습니다.

## OpenClaw에서 Copilot을 사용하는 두 가지 방법

### 1) 내장된 GitHub Copilot 프로바이더 (`github-copilot`)

기기의 로그인 플로우를 사용하여 GitHub 토큰을 얻은 후, OpenClaw가 실행될 때 Copilot API 토큰으로 교환하세요. 이는 **기본** 경로이며 가장 간단한 경로입니다. 이 방법은 VS Code가 필요하지 않기 때문입니다.

### 2) Copilot Proxy 플러그인 (`copilot-proxy`)

**Copilot Proxy** VS Code 확장을 로컬 브리지로 사용하세요. OpenClaw는 프록시의 `/v1` 엔드포인트와 통신하며, 여러분이 설정한 모델 목록을 사용합니다. 이미 VS Code에서 Copilot Proxy를 실행 중이거나 프록시를 통해 라우팅해야 할 경우 이를 선택하세요. 플러그인을 활성화하고 VS Code 확장이 실행되고 있어야 합니다.

GitHub Copilot을 모델 프로바이더로 사용하세요 (`github-copilot`). 로그인 명령어는 GitHub 디바이스 플로우를 실행하며, 인증 프로파일을 저장하고 해당 프로파일을 사용하도록 설정을 업데이트합니다.

## CLI 설정

```bash
openclaw models auth login-github-copilot
```

URL을 방문하고 일회용 코드를 입력하라는 메시지가 표시됩니다. 완료될 때까지 터미널을 열어 두십시오.

### 선택적 플래그

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## 기본 모델 설정

```bash
openclaw models set github-copilot/gpt-4o
```

### 설정 코드 조각

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## 참고 사항

- 인터랙티브 TTY가 필요합니다. 직접 터미널에서 실행하세요.
- Copilot 모델의 가용성은 여러분의 계획에 따라 달라집니다. 모델이 거부되면 다른 ID(예: `github-copilot/gpt-4.1`)를 시도하세요.
- 로그인을 통해 GitHub 토큰이 인증 프로파일 저장소에 저장되며, OpenClaw가 실행될 때 Copilot API 토큰으로 교환됩니다.
