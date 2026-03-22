---
summary: "브라우저 자동화를 위한 수동 로그인 + X/Twitter 게시"
read_when:
  - 브라우저 자동화를 위해 사이트에 로그인해야 할 때
  - X/Twitter 에 업데이트를 게시하고 싶을 때
title: "브라우저 로그인"
x-i18n:
  source_path: docs/tools/browser-login.md
---

# 브라우저 로그인 + X/Twitter 게시

## 수동 로그인 (권장)

사이트에 로그인이 필요한 경우, **호스트** 브라우저 프로필 (openclaw 브라우저) 에서 **수동으로 로그인**하세요.

모델에 자격 증명을 제공하지 **마세요**. 자동화된 로그인은 종종 안티봇 방어를 트리거하고 계정을 잠글 수 있습니다.

메인 브라우저 문서로 돌아가기: [Browser](/tools/browser).

## 어떤 Chrome 프로필이 사용되나요?

OpenClaw 은 **전용 Chrome 프로필** (`openclaw`이라는 이름, 주황색 UI) 을 제어합니다. 이것은 일상적인 브라우저 프로필과 별개입니다.

에이전트 브라우저 도구 호출의 경우:

- 기본 선택: 에이전트는 격리된 `openclaw` 브라우저를 사용해야 합니다.
- 기존 로그인 세션이 중요하고 사용자가 컴퓨터 앞에서 연결 프롬프트를 클릭/승인할 수 있는 경우에만 `profile="user"`를 사용하세요.
- 여러 사용자 브라우저 프로필이 있는 경우 추측하지 말고 프로필을 명시적으로 지정하세요.

접근하는 두 가지 쉬운 방법:

1. **에이전트에게 브라우저를 열도록 요청**한 다음 직접 로그인합니다.
2. **CLI 를 통해 열기**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

여러 프로필이 있는 경우 `--browser-profile <name>`을 전달합니다 (기본값은 `openclaw`).

## X/Twitter: 권장 흐름

- **읽기/검색/스레드:** **호스트** 브라우저 사용 (수동 로그인).
- **업데이트 게시:** **호스트** 브라우저 사용 (수동 로그인).

## 샌드박싱 + 호스트 브라우저 접근

샌드박스된 브라우저 세션은 봇 감지를 트리거할 **가능성이 더 높습니다**. X/Twitter (및 기타 엄격한 사이트) 의 경우 **호스트** 브라우저를 선호합니다.

에이전트가 샌드박스된 경우 브라우저 도구는 기본적으로 샌드박스를 사용합니다. 호스트 제어를 허용하려면:

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

그런 다음 호스트 브라우저를 대상으로 합니다:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

또는 업데이트를 게시하는 에이전트에 대해 샌드박싱을 비활성화합니다.
