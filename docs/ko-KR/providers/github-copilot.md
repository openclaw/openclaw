---
summary: "디바이스 플로우를 사용하여 OpenClaw 에서 GitHub Copilot 에 로그인하기"
read_when:
  - GitHub Copilot 을 모델 프로바이더로 사용하고 싶을 때
  - "`openclaw models auth login-github-copilot` 플로우가 필요할 때"
title: "GitHub Copilot"
x-i18n:
  source_path: docs/providers/github-copilot.md
---

# GitHub Copilot

## GitHub Copilot 이란?

GitHub Copilot 은 GitHub 의 AI 코딩 어시스턴트입니다. GitHub 계정과 플랜에 맞는 Copilot 모델에 대한 액세스를 제공합니다. OpenClaw 는 두 가지 방법으로 Copilot 을 모델 프로바이더로 사용할 수 있습니다.

## OpenClaw 에서 Copilot 을 사용하는 두 가지 방법

### 1) 내장 GitHub Copilot 프로바이더 (`github-copilot`)

네이티브 디바이스 로그인 플로우를 사용하여 GitHub 토큰을 얻은 다음, OpenClaw 실행 시 Copilot API 토큰으로 교환합니다. 이것은 VS Code 가 필요하지 않기 때문에 **기본적이고** 가장 간단한 경로입니다.

### 2) Copilot Proxy 플러그인 (`copilot-proxy`)

**Copilot Proxy** VS Code 확장 프로그램을 로컬 브릿지로 사용합니다. OpenClaw 는 프록시의 `/v1` 엔드포인트와 통신하며 거기에서 설정한 모델 목록을 사용합니다. 이미 VS Code 에서 Copilot Proxy 를 실행 중이거나 이를 통해 라우팅해야 하는 경우 이 방법을 선택하세요. 플러그인을 활성화하고 VS Code 확장 프로그램을 계속 실행해야 합니다.

GitHub Copilot 을 모델 프로바이더 (`github-copilot`) 로 사용하세요. 로그인 명령은 GitHub 디바이스 플로우를 실행하고, 인증 프로필을 저장하며, 해당 프로필을 사용하도록 설정을 업데이트합니다.

## CLI 설정

```bash
openclaw models auth login-github-copilot
```

URL 을 방문하고 일회용 코드를 입력하라는 메시지가 표시됩니다. 완료될 때까지 터미널을 열어 두세요.

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

- 대화형 TTY 가 필요합니다. 터미널에서 직접 실행하세요.
- Copilot 모델 가용성은 플랜에 따라 다릅니다. 모델이 거부되면
  다른 ID 를 시도하세요 (예: `github-copilot/gpt-4.1`).
- 로그인은 인증 프로필 저장소에 GitHub 토큰을 저장하고 OpenClaw 실행 시
  Copilot API 토큰으로 교환합니다.
