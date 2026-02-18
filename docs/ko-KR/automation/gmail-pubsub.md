---
summary: "Gmail Pub/Sub 푸시를 gogcli를 통해 OpenClaw 웹훅에 연결"
read_when:
  - Gmail 받은 편지함 트리거를 OpenClaw로 연결하기
  - 에이전트 웨이크를 위한 Pub/Sub 푸시 설정
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

목표: Gmail 감시 -> Pub/Sub 푸시 -> `gog gmail watch serve` -> OpenClaw 웹훅.

## 필수 조건

- `gcloud` 설치 및 로그인 ([설치 가이드](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) 설치 및 Gmail 계정에 대한 인증 ([gogcli.sh](https://gogcli.sh/)).
- OpenClaw 훅 활성화됨 (참조 [웹훅](/automation/webhook)).
- `tailscale` 로그인 ([tailscale.com](https://tailscale.com/)). 지원되는 설정은 Tailscale 퍼널을 사용하여 공개 HTTPS 엔드포인트 제공.
  다른 터널 서비스도 사용 가능하지만 DIY, 비지원이며 수동 연결이 필요.
  현재는 Tailscale을 지원.

예시 훅 설정 (Gmail 프리셋 매핑 활성화):

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

Gmail 요약을 채팅 화면으로 전달하려면 `deliver` + 선택적 `channel`/`to`를 설정하는 매핑으로 프리셋을 재정의:

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

고정된 채널을 원하면 `channel` + `to`를 설정. 그렇지 않을 경우 `channel: "last"`는 마지막 전달 경로를 사용 (기본값은 WhatsApp).

Gmail 실행 시 저렴한 모델을 강제하려면 매핑에서 `model` 설정 (`provider/model` 또는 별칭). `agents.defaults.models`을 설정하면 여기에도 포함.

Gmail 훅에 대해 기본 모델 및 사고 수준을 설정하려면 설정에 `hooks.gmail.model` / `hooks.gmail.thinking` 추가:

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

주의사항:

- 매핑 내부의 훅 별 `model`/`thinking`은 여전히 이 기본값을 재정의.
- 대체 순서: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → 기본 (인증/속도 제한/시간 초과).
- `agents.defaults.models`이 설정되어 있으면 Gmail 모델은 허용 목록에 있어야 함.
- Gmail 훅 콘텐츠는 기본적으로 외부 콘텐츠 안전 경계로 감싸짐.
  비활성화하려면 (위험) `hooks.gmail.allowUnsafeExternalContent: true` 설정.

페이로드 처리를 더욱 커스터마이즈하려면, 설정의 `hooks.mappings` 또는 `~/.openclaw/hooks/transforms` 아래에 JS/TS 변환 모듈 추가 (참조 [웹훅](/automation/webhook)).

## 마법사 (권장)

OpenClaw 도우미를 사용하여 모든 것을 함께 연결 (macOS에서 brew를 통해 종속성 설치):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

기본값:

- 공개 푸시 엔드포인트로 Tailscale 퍼널 사용.
- `openclaw webhooks gmail run`을 위한 `hooks.gmail` 설정 작성.
- Gmail 훅 프리셋 활성화 (`hooks.presets: ["gmail"]`).

경로 주의사항: `tailscale.mode`가 활성화되면, OpenClaw는 자동으로 `hooks.gmail.serve.path`를 `/`로 설정하고 공개 경로를 `hooks.gmail.tailscale.path`에 유지 (기본값 `/gmail-pubsub`) Tailscale이 프록시 전에 지정된 경로 접두사를 제거하기 때문.
백엔드에서 접두사 경로를 수신해야 하는 경우, `hooks.gmail.tailscale.target` (또는 `--tailscale-target`)을 `http://127.0.0.1:8788/gmail-pubsub`과 같은 전체 URL로 설정하고 `hooks.gmail.serve.path`에 맞춤 설정.

커스텀 엔드포인트가 필요? `--push-endpoint <url>` 또는 `--tailscale off` 사용.

플랫폼 주의사항: macOS에서는 마법사가 `gcloud`, `gogcli`, `tailscale`을 Homebrew로 설치; Linux에서는 수동으로 먼저 설치.

게이트웨이 자동 시작 (권장):

- `hooks.enabled=true` 및 `hooks.gmail.account`이 설정되면, 게이트웨이는 부팅 시 `gog gmail watch serve`를 시작하고 감시를 자동 갱신.
- `OPENCLAW_SKIP_GMAIL_WATCHER=1` 설정하여 옵트아웃 (데몬을 직접 실행하는 경우 유용함).
- 수동 데몬을 동시에 실행하지 말 것, 아니면 `listen tcp 127.0.0.1:8788: bind: address already in use`에 걸림.

수동 데몬 (자동 갱신과 함께 `gog gmail watch serve` 시작):

```bash
openclaw webhooks gmail run
```

## 일회성 설정

1. **gog 에서 사용한 OAuth 클라이언트를 소유한** GCP 프로젝트 선택:

```bash
gcloud auth login
gcloud config set project <project-id>
```

주의: Gmail 감시는 OAuth 클라이언트가 있는 동일한 프로젝트에 Pub/Sub 주제가 있어야 함.

2. API 활성화:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. 주제 생성:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Gmail 푸시를 통한 게시 허용:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## 감시 시작

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

출력에서 `history_id`를 저장 (디버깅 용).

## 푸시 핸들러 실행

로컬 예제 (공유 토큰 인증):

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

주의사항:

- `--token`은 푸시 엔드포인트를 보호 (`x-gog-token` 또는 `?token=`).
- `--hook-url`은 OpenClaw `/hooks/gmail`을 가리킴 (매핑됨; 격리 실행 + 요약을 메인으로).
- `--include-body` 및 `--max-bytes`는 OpenClaw에 전송되는 본문 스니펫 제어.

권장: `openclaw webhooks gmail run`은 동일한 흐름을 포장하고 감시를 자동 갱신.

## 핸들러 노출 (고급, 비지원)

비 Tailscale 터널이 필요하다면 수동으로 연결하고 푸시 구독에 공개 URL을 사용 (비지원, 안전장치 없음):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

생성된 URL을 푸시 엔드포인트로 사용:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

프로덕션: 안전한 HTTPS 엔드포인트를 사용하고 Pub/Sub OIDC JWT를 구성한 뒤 실행:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## 테스트

감시된 받은 편지함에 메시지 전송:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

감시 상태 및 기록 확인:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## 문제 해결

- `Invalid topicName`: 프로젝트 불일치 (주제가 OAuth 클라이언트 프로젝트에 없음).
- `User not authorized`: 주제에서 `roles/pubsub.publisher` 누락.
- 빈 메시지: Gmail 푸시는 `historyId`만 제공; `gog gmail history`를 통해 가져옴.

## 정리

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
