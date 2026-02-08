---
read_when:
    - Gmail 받은편지함 트리거를 OpenClaw에 연결
    - 에이전트 깨우기를 위한 Pub/Sub 푸시 설정
summary: gogcli를 통해 OpenClaw 웹후크에 연결된 Gmail Pub/Sub 푸시
title: Gmail PubSub
x-i18n:
    generated_at: "2026-02-08T15:46:33Z"
    model: gtx
    provider: google-translate
    source_hash: dfb92133b69177e4e984b7d072f5dc28aa53a9e0cf984a018145ed811aa96195
    source_path: automation/gmail-pubsub.md
    workflow: 15
---

# Gmail 게시/구독 -> OpenClaw

목표: Gmail 감시 -> Pub/Sub 푸시 -> `gog gmail watch serve` -> OpenClaw 웹훅.

## 전제조건

- `gcloud` 설치 및 로그인([설치 가이드](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli)가 Gmail 계정([gogcli.sh](https://gogcli.sh/)).
- OpenClaw 후크 활성화됨(참조 [웹훅](/automation/webhook)).
- `tailscale` 로그인됨([tailscale.com](https://tailscale.com/)). 지원되는 설정은 공용 HTTPS 엔드포인트에 Tailscale Funnel을 사용합니다.
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
그 설정 `deliver` + 선택사항 `channel`/`to`:

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

고정된 채널을 원할 경우 다음을 설정하세요. `channel` + `to`. 그렇지 않으면 `channel: "last"`
마지막 배달 경로를 사용합니다(WhatsApp으로 대체).

Gmail 실행을 위해 더 저렴한 모델을 강제하려면 다음을 설정하세요. `model` 매핑에서
(`provider/model` 또는 별칭). 시행한다면 `agents.defaults.models`, 거기에 포함하세요.

Gmail 후크에 대한 기본 모델 및 사고 수준을 설정하려면 다음을 추가하세요.
`hooks.gmail.model`/`hooks.gmail.thinking` 귀하의 구성에서 :

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

- 후크별 `model`/`thinking` 매핑에서는 여전히 이러한 기본값을 재정의합니다.
- 대체 순서: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → 기본(인증/속도 제한/시간 초과).
- 만약에 `agents.defaults.models` 설정되면 Gmail 모델이 허용 목록에 있어야 합니다.
- Gmail 후크 콘텐츠는 기본적으로 외부 콘텐츠 안전 경계로 래핑됩니다.
  비활성화 (위험)하려면 다음을 설정하십시오. `hooks.gmail.allowUnsafeExternalContent: true`.

페이로드 처리를 추가로 사용자 정의하려면 다음을 추가하십시오. `hooks.mappings` 또는 JS/TS 변환 모듈
아래 `hooks.transformsDir` (보다 [웹훅](/automation/webhook)).

## 마법사(권장)

OpenClaw 도우미를 사용하여 모든 것을 함께 연결합니다(brew를 통해 macOS에 deps 설치).

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

기본값:

- 공개 푸시 엔드포인트에 Tailscale Funnel을 사용합니다.
- 쓰기 `hooks.gmail` 구성 `openclaw webhooks gmail run`.
- Gmail 후크 사전 설정을 활성화합니다(`hooks.presets: ["gmail"]`).

경로 참고: 언제 `tailscale.mode` 활성화되면 OpenClaw가 자동으로 설정됩니다.
`hooks.gmail.serve.path` 에게 `/` 공개 경로를 다음과 같이 유지합니다.
`hooks.gmail.tailscale.path` (기본 `/gmail-pubsub`) Tailscale 때문에
프록싱하기 전에 set-path 접두사를 제거합니다.
접두사가 붙은 경로를 수신하기 위해 백엔드가 필요한 경우 다음을 설정하세요.
`hooks.gmail.tailscale.target` (또는 `--tailscale-target`)를 다음과 같은 전체 URL로
`http://127.0.0.1:8788/gmail-pubsub` 그리고 일치 `hooks.gmail.serve.path`.

맞춤형 엔드포인트를 원하시나요? 사용 `--push-endpoint <url>` 또는 `--tailscale off`.

플랫폼 참고 사항: macOS에서는 마법사가 설치합니다. `gcloud`, `gogcli`, 그리고 `tailscale`
Homebrew를 통해; Linux에서는 먼저 수동으로 설치하세요.

게이트웨이 자동 시작(권장):

- 언제 `hooks.enabled=true` 그리고 `hooks.gmail.account` 설정되면 게이트웨이가 시작됩니다.
  `gog gmail watch serve` 부팅 시 시계를 자동 갱신합니다.
- 세트 `OPENCLAW_SKIP_GMAIL_WATCHER=1` 옵트아웃(데몬을 직접 실행하는 경우 유용함)
- 수동 데몬을 동시에 실행하지 마십시오.
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

수동 데몬(시작 `gog gmail watch serve` + 자동 갱신):

```bash
openclaw webhooks gmail run
```

## 일회성 설정

1. GCP 프로젝트 선택 **OAuth 클라이언트를 소유한 사람** 에 의해 사용됨 `gog`.

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

저장 `history_id` 출력에서 (디버깅용)

## 푸시 핸들러 실행

로컬 예시(공유 토큰 인증):

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

- `--token` 푸시 엔드포인트를 보호합니다(`x-gog-token` 또는 `?token=`).
- `--hook-url` OpenClaw를 가리킨다 `/hooks/gmail` (매핑됨; 격리된 실행 + 기본 요약)
- `--include-body` 그리고 `--max-bytes` OpenClaw로 전송된 본문 조각을 제어합니다.

권장사항: `openclaw webhooks gmail run` 동일한 흐름을 래핑하고 시계를 자동 갱신합니다.

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

## 시험

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

- `Invalid topicName`: 프로젝트 불일치(OAuth 클라이언트 프로젝트에 없는 주제)
- `User not authorized`: 없어진 `roles/pubsub.publisher` 주제에.
- 빈 메시지: Gmail 푸시만 제공 `historyId`; 다음을 통해 가져오기 `gog gmail history`.

## 대청소

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
