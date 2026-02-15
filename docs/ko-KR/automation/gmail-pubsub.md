---
summary: "Gmail Pub/Sub push wired into OpenClaw webhooks via gogcli"
read_when:
  - Wiring Gmail inbox triggers to OpenClaw
  - Setting up Pub/Sub push for agent wake
title: "Gmail PubSub"
x-i18n:
  source_hash: dfb92133b69177e4e984b7d072f5dc28aa53a9e0cf984a018145ed811aa96195
---

# Gmail 게시/구독 -> OpenClaw

목표: Gmail 감시 -> Pub/Sub 푸시 -> `gog gmail watch serve` -> OpenClaw 웹훅.

## 전제조건

- `gcloud`를 설치하고 로그인했습니다([설치 가이드](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli)가 Gmail 계정([gogcli.sh](https://gogcli.sh/))에 설치 및 승인되었습니다.
- OpenClaw 후크가 활성화되었습니다([웹후크](/automation/webhook) 참조).
- `tailscale` 로그인했습니다([tailscale.com](https://tailscale.com/)). 지원되는 설정은 공용 HTTPS 엔드포인트에 Tailscale Funnel을 사용합니다.
  다른 터널 서비스도 가능하지만 DIY/지원되지 않으며 수동 배선이 필요합니다.
  현재 우리가 지원하는 것은 Tailscale입니다.

후크 구성 예(Gmail 사전 설정 매핑 활성화):

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

Gmail 요약을 채팅 화면에 전달하려면 매핑으로 사전 설정을 재정의하세요.
`deliver` + 선택 사항 `channel`/`to`를 설정합니다.

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

고정된 채널을 원하시면 `channel` + `to`를 설정하세요. 그렇지 않은 경우 `channel: "last"`
마지막 배달 경로를 사용합니다(WhatsApp으로 대체).

Gmail 실행을 위해 더 저렴한 모델을 강제하려면 매핑에서 `model`를 설정하세요.
(`provider/model` 또는 별칭). `agents.defaults.models`를 시행하는 경우 여기에 포함하세요.

Gmail 후크에 대한 기본 모델 및 사고 수준을 설정하려면 다음을 추가하세요.
`hooks.gmail.model` / `hooks.gmail.thinking` 구성에서:

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

참고:

- 매핑의 후크별 `model`/`thinking`는 여전히 이러한 기본값을 재정의합니다.
- 대체 순서: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → 기본(인증/속도 제한/시간 초과).
- `agents.defaults.models`가 설정된 경우 Gmail 모델이 허용 목록에 있어야 합니다.
- Gmail 후크 콘텐츠는 기본적으로 외부 콘텐츠 안전 경계로 래핑됩니다.
  비활성화(위험)하려면 `hooks.gmail.allowUnsafeExternalContent: true`를 설정하세요.

페이로드 처리를 추가로 사용자 정의하려면 `hooks.mappings` 또는 JS/TS 변환 모듈을 추가하세요.
`hooks.transformsDir` 아래([웹후크](/automation/webhook) 참조).

## 마법사(권장)

OpenClaw 도우미를 사용하여 모든 것을 함께 연결합니다(brew를 통해 macOS에 deps 설치).

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

기본값:

- 공개 푸시 엔드포인트에 Tailscale Funnel을 사용합니다.
- `openclaw webhooks gmail run`에 `hooks.gmail` 구성을 씁니다.
- Gmail 후크 사전 설정(`hooks.presets: ["gmail"]`)을 활성화합니다.

경로 참고: `tailscale.mode`가 활성화되면 OpenClaw가 자동으로 설정합니다.
`hooks.gmail.serve.path`를 `/`로 변경하고 공개 경로를 다음 위치에 유지합니다.
`hooks.gmail.tailscale.path` (기본값 `/gmail-pubsub`) Tailscale 때문에
프록싱하기 전에 set-path 접두사를 제거합니다.
접두사가 붙은 경로를 수신하기 위해 백엔드가 필요한 경우 다음을 설정하세요.
`hooks.gmail.tailscale.target` (또는 `--tailscale-target`)를 다음과 같은 전체 URL로
`http://127.0.0.1:8788/gmail-pubsub` 및 `hooks.gmail.serve.path`과 일치합니다.

맞춤형 엔드포인트를 원하시나요? `--push-endpoint <url>` 또는 `--tailscale off`를 사용하세요.

플랫폼 참고 사항: macOS에서 마법사는 `gcloud`, `gogcli` 및 `tailscale`를 설치합니다.
Homebrew를 통해; Linux에서는 먼저 수동으로 설치하세요.

게이트웨이 자동 시작(권장):

- `hooks.enabled=true`, `hooks.gmail.account`를 설정하면 게이트웨이가 시작됩니다.
  `gog gmail watch serve` 부팅 시 시계가 자동 갱신됩니다.
- `OPENCLAW_SKIP_GMAIL_WATCHER=1`을 선택 해제하도록 설정합니다(데몬을 직접 실행하는 경우 유용함).
- 수동 데몬을 동시에 실행하지 마십시오.
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

수동 데몬(`gog gmail watch serve` 시작 + 자동 갱신):

```bash
openclaw webhooks gmail run
```

## 일회성 설정

1. `gog`에서 사용하는 **OAuth 클라이언트를 소유한** GCP 프로젝트를 선택합니다.

```bash
gcloud auth login
gcloud config set project <project-id>
```

참고: Gmail 시계를 사용하려면 Pub/Sub 주제가 OAuth 클라이언트와 동일한 프로젝트에 있어야 합니다.

2. API 활성화:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. 주제를 생성합니다:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Gmail 푸시 게시를 허용합니다.

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

출력에서 `history_id`를 저장합니다(디버깅용).

## 푸시 핸들러 실행

로컬 예(공유 토큰 인증):

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

참고:

- `--token`는 푸시 엔드포인트(`x-gog-token` 또는 `?token=`)를 보호합니다.
- `--hook-url`는 OpenClaw `/hooks/gmail`를 가리킵니다(매핑됨, 격리된 실행 + 기본 요약).
- `--include-body` 및 `--max-bytes`는 OpenClaw로 전송되는 본문 조각을 제어합니다.

권장 사항: `openclaw webhooks gmail run`는 동일한 흐름을 래핑하고 시계를 자동 갱신합니다.

## 핸들러 노출(고급, 지원되지 않음)

Tailscale이 아닌 터널이 필요한 경우 수동으로 연결하고 푸시 시 공용 URL을 사용하세요.
구독(지원되지 않음, 가드레일 없음):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

생성된 URL을 푸시 엔드포인트로 사용합니다.

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

프로덕션: 안정적인 HTTPS 엔드포인트를 사용하고 Pub/Sub OIDC JWT를 구성한 후 다음을 실행합니다.

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## 테스트

감시된 받은편지함으로 메시지 보내기:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

시계 상태 및 기록을 확인하세요.

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## 문제 해결

- `Invalid topicName`: 프로젝트 불일치(OAuth 클라이언트 프로젝트에 없는 주제).
- `User not authorized`: 주제에 `roles/pubsub.publisher`가 누락되었습니다.
- 빈 메시지: Gmail 푸시는 `historyId`만 제공합니다. `gog gmail history`를 통해 가져옵니다.

## 정리

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
