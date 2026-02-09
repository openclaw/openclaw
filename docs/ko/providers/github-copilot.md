---
summary: "OpenClaw 에서 디바이스 플로우를 사용해 GitHub Copilot 에 로그인합니다"
read_when:
  - GitHub Copilot 을 모델 프로바이더로 사용하려는 경우
  - "`openclaw models auth login-github-copilot` 플로우가 필요한 경우"
title: "GitHub Copilot"
---

# GitHub Copilot

## GitHub Copilot 이란 무엇입니까?

GitHub Copilot 은 GitHub 의 AI 코딩 어시스턴트입니다. GitHub 계정과 요금제에 대해 Copilot 모델에 대한 접근을 제공합니다. OpenClaw 는 Copilot 을 두 가지 서로 다른 방식으로 모델 프로바이더로 사용할 수 있습니다.

## OpenClaw 에서 Copilot 을 사용하는 두 가지 방법

### 1. 내장 GitHub Copilot 프로바이더 (`github-copilot`)

네이티브 디바이스 로그인 플로우를 사용해 GitHub 토큰을 획득한 다음, OpenClaw 가 실행될 때 이를 Copilot API 토큰으로 교환합니다. 이는 VS Code 가 필요하지 않기 때문에 **기본값** 이며 가장 간단한 경로입니다.

### 2. Copilot Proxy 플러그인 (`copilot-proxy`)

**Copilot Proxy** VS Code 확장을 로컬 브리지로 사용합니다. OpenClaw 는 프록시의 `/v1` 엔드포인트와 통신하며, 그곳에서 구성한 모델 목록을 사용합니다. 이미 VS Code 에서 Copilot Proxy 를 실행 중이거나 이를 통해 라우팅해야 하는 경우 이 방법을 선택하십시오.
플러그인을 활성화하고 VS Code 확장을 계속 실행해야 합니다.

GitHub Copilot 을 모델 프로바이더로 사용합니다 (`github-copilot`). 로그인 명령은 GitHub 디바이스 플로우를 실행하고, 인증 프로파일을 저장하며, 해당 프로파일을 사용하도록 설정을 업데이트합니다.

## CLI 설정

```bash
openclaw models auth login-github-copilot
```

URL 을 방문하고 일회성 코드를 입력하라는 안내가 표시됩니다. 완료될 때까지 터미널을 열린 상태로 유지하십시오.

### 선택적 플래그

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## 기본 모델 설정

```bash
openclaw models set github-copilot/gpt-4o
```

### 설정 스니펫

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## 참고 사항

- 대화형 TTY 가 필요합니다. 터미널에서 직접 실행하십시오.
- Copilot 모델 사용 가능 여부는 요금제에 따라 다릅니다. 모델이 거부되는 경우 다른 ID 를 시도하십시오(예: `github-copilot/gpt-4.1`).
- 로그인 과정은 인증 프로파일 저장소에 GitHub 토큰을 저장하고, OpenClaw 가 실행될 때 이를 Copilot API 토큰으로 교환합니다.
