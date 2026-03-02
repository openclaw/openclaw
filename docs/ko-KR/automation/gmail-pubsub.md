---
summary: "Gmail Pub/Sub이 gogcli를 통해 OpenClaw webhook으로 푸시"
read_when:
  - "Gmail 받은편지함 트리거를 OpenClaw에 와이어링할 때"
  - "에이전트 웨이크에 대한 Pub/Sub 푸시를 설정할 때"
title: "Gmail PubSub"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/automation/gmail-pubsub.md
  workflow: 15
---

# Gmail Pub/Sub -> OpenClaw

목표: Gmail watch -> Pub/Sub push -> `gog gmail watch serve` -> OpenClaw webhook.

## 전제 조건

- `gcloud` 설치 및 로그인 ([설치 가이드](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) 설치 및 Gmail 계정 인증 ([gogcli.sh](https://gogcli.sh/)).
- OpenClaw hooks 활성화 ([Webhook](/automation/webhook) 참조).
- `tailscale` 로그인 ([tailscale.com](https://tailscale.com/)). 지원하는 설정은 공개 HTTPS 엔드포인트에 Tailscale Funnel을 사용합니다.
  다른 터널 서비스가 작동할 수 있지만 DIY/지원되지 않으며 수동 와이어링이 필요합니다.
  지금 우리가 지원하는 것은 Tailscale입니다.

예제 훅 구성 (Gmail 사전 설정 매핑 활성화):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

채팅 표면으로 Gmail 요약을 배달하려면 `deliver` + 선택적 `channel`/`to`를 설정하는 매핑으로 사전 설정을 오버라이드합니다:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

고정된 채널을 원하면 `channel` + `to`를 설정합니다. 그렇지 않으면 `channel: "last"`는 마지막 배달 경로를 사용합니다 (WhatsApp로 폴백).

Gmail 실행에 대해 저렴한 모델을 강제하려면 매핑에서 `model`을 설정합니다 (`provider/model` 또는 별칭). `agents.defaults.models`를 강제하면 거기에 포함하세요.

Gmail 훅에 대해서만 기본 모델 및 사고 수준을 설정하려면 구성에서 `hooks.gmail.model` / `hooks.gmail.thinking`을 추가합니다:

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

메모:

- 매핑의 훅별 `model`/`thinking`은 여전히 이 기본값을 오버라이드합니다.
- 폴백 순서: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → 기본 (auth/속도 제한/타임아웃).
- `agents.defaults.models`이 설정되면 Gmail 모델이 allowlist에 있어야 합니다.
- Gmail 훅 콘텐츠는 기본적으로 외부 콘텐츠 안전 경계로 래핑됩니다.
  비활성화하려면 (위험) `hooks.gmail.allowUnsafeExternalContent: true`를 설정합니다.

페이로드 처리를 더 커스터마이즈하려면 `hooks.mappings`을 추가하거나 `~/.openclaw/hooks/transforms` 아래에 JS/TS 변환 모듈을 추가합니다 ([Webhook](/automation/webhook) 참조).

## 마법사 (권장)

OpenClaw 헬퍼를 사용하여 모두 함께 와이어링합니다 (macOS에서 brew를 통해 deps 설치):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

기본값:

- 공개 푸시 엔드포인트에 Tailscale Funnel을 사용합니다.
- `openclaw webhooks gmail run`을 위한 `hooks.gmail` 구성을 씁니다.
- Gmail 훅 사전 설정을 활성화합니다 (`hooks.presets: ["gmail"]`).

경로 메모: `tailscale.mode`가 활성화되면 OpenClaw는 자동으로 `hooks.gmail.serve.path`를 `/`로 설정하고
공개 경로를 `hooks.gmail.tailscale.path` (기본값 `/gmail-pubsub`)로 유지합니다 (Tailscale이 프록싱 전에 설정 경로를 제거하므로).
백엔드가 접두사가 있는 경로를 수신하려면 `hooks.gmail.tailscale.target`을 `http://127.0.0.1:8788/gmail-pubsub`과 같은 전체 URL로 설정하고 `hooks.gmail.serve.path`와 일치시킵니다.

커스텀 엔드포인트를 원하나요? `--push-endpoint <url>` 또는 `--tailscale off`를 사용합니다.

플랫폼 메모: macOS에서 마법사는 Homebrew를 통해 `gcloud`, `gogcli`, 및 `tailscale`을 설치합니다. Linux에서 먼저 수동으로 설치합니다.

Gateway 자동 시작 (권장):

- `hooks.enabled=true` 및 `hooks.gmail.account`가 설정되면 Gateway는 부트 시 `gog gmail watch serve`를 시작하고 watch를 자동 갱신합니다.
- `OPENCLAW_SKIP_GMAIL_WATCHER=1`을 설정하여 선택 해제합니다 (데몬을 직접 실행하면 유용).
- 같은 시간에 수동 데몬을 실행하지 마세요. `listen tcp 127.0.0.1:8788: bind: address already in use`를 얻을 것입니다.

수동 데몬 (시작 `gog gmail watch serve` + 자동 갱신):

```bash
openclaw webhooks gmail run
```

## 일회성 설정

1. `gog`에서 사용하는 OAuth 클라이언트를 **소유하는** GCP 프로젝트를 선택합니다.

```bash
gcloud auth login
gcloud config set project <project-id>
```

메모: Gmail watch는 Pub/Sub 주제가 OAuth 클라이언트와 같은 프로젝트에 있어야 합니다.

2. API 활성화:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. 주제 생성:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Gmail 푸시를 게시하도록 허용:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## 시계 시작

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

출력에서 `history_id`를 저장합니다 (디버깅용).

## 푸시 핸들러 실행

로컬 예 (공유 토큰 auth):

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

메모:

- `--token`은 푸시 엔드포인트를 보호합니다 (`x-gog-token` 또는 `?token=`).
- `--hook-url`은 OpenClaw `/hooks/gmail` (매핑; 격리 실행 + 메인으로 요약)을 가리킵니다.
- `--include-body` 및 `--max-bytes`는 OpenClaw로 전송된 본문 스니펫을 제어합니다.

권장: `openclaw webhooks gmail run`은 동일한 흐름을 래핑하고 watch를 자동 갱신합니다.

## 테스트

시계 받은편지함에 메시지를 전송합니다:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

시계 상태 및 히스토리를 확인합니다:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## 정리

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
