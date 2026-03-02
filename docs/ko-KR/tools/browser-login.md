---
summary: "Manual logins for browser automation + X/Twitter posting"
read_when:
  - You need to log into sites for browser automation
  - You want to post updates to X/Twitter
title: "Browser Login"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/tools/browser-login.md
workflow: 15
---

# Browser login + X/Twitter posting

## Manual login (권장)

사이트에 로그인이 필요할 때, **host** browser 프로필 (openclaw browser) 에서 **수동으로 로그인** 합니다.

모델에 자격증명을 제공하지 **마십시오**. 자동화된 로그인은 종종 anti‑bot 방어를 트리거하여 계정을 잠글 수 있습니다.

main browser docs 로 돌아가기: [Browser](/tools/browser).

## 어떤 Chrome 프로필이 사용되나요?

OpenClaw 는 **dedicated Chrome 프로필** (이름: `openclaw`, 주황색 강조 UI) 을 제어합니다. 이는 일상적인 browser 프로필과 별도입니다.

이에 액세스하는 두 가지 쉬운 방법:

1. **agent 에게 browser 열기를 요청** 한 다음 직접 로그인합니다.
2. **CLI 를 통해 열기**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

여러 프로필이 있는 경우, `--browser-profile <name>` 을 전달합니다 (기본값은 `openclaw`).

## X/Twitter: 권장 흐름

- **읽기/검색/스레드:** **host** browser 사용 (수동 로그인).
- **게시물 업데이트:** **host** browser 사용 (수동 로그인).

## Sandboxing + host browser 액세스

Sandboxed browser sessions 은 bot detection 을 트리거할 **가능성이 더 높습니다**. X/Twitter (및 기타 strict sites) 의 경우, **host** browser 를 선호합니다.

agent 가 sandboxed 인 경우, browser tool 은 기본적으로 sandbox 를 대상으로 합니다. host 제어를 허용하려면:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

그런 다음 host browser 를 대상으로 합니다:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

또는 업데이트를 게시하는 agent 에 대해 sandboxing 을 비활성화합니다.
