---
summary: "Manual logins for browser automation + X/Twitter posting"
read_when:
  - You need to log into sites for browser automation
  - You want to post updates to X/Twitter
title: "Browser Login"
x-i18n:
  source_hash: c30faa9da6c6ef70ab8ee7dd9835572d8b16efd3ac3b99c2f55d25f798564ee9
---

# 브라우저 로그인 + X/트위터 포스팅

## 수동 로그인(권장)

사이트에 로그인이 필요한 경우 **호스트** 브라우저 프로필(openclaw 브라우저)에서 **수동으로 로그인**하세요.

모델에 자격 증명을 제공하지 **마세요**. 자동 로그인은 종종 안티 봇 방어를 실행하고 계정을 잠글 수 있습니다.

기본 브라우저 문서로 돌아가기: [브라우저](/tools/browser).

## 어떤 Chrome 프로필이 사용되나요?

OpenClaw는 **전용 Chrome 프로필**(이름: `openclaw`, 주황색 UI)을 제어합니다. 이는 일일 브라우저 프로필과 별개입니다.

액세스하는 두 가지 쉬운 방법:

1. **상담원에게 브라우저를 열도록 요청**한 후 직접 로그인하세요.
2. **CLI를 통해 엽니다**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

프로필이 여러 개인 경우 `--browser-profile <name>`를 전달합니다(기본값은 `openclaw`).

## X/Twitter: 권장 흐름

- **읽기/검색/스레드:** **호스트** 브라우저를 사용합니다(수동 로그인).
- **업데이트 게시:** **호스트** 브라우저를 사용합니다(수동 로그인).

## 샌드박싱 + 호스트 브라우저 액세스

샌드박스가 적용된 브라우저 세션은 봇 감지를 트리거할 **가능성이 더 높습니다**. X/Twitter(및 기타 엄격한 사이트)의 경우 **호스트** 브라우저를 선호하세요.

에이전트가 샌드박스 처리된 경우 브라우저 도구는 기본적으로 샌드박스를 사용합니다. 호스트 제어를 허용하려면:

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

그런 다음 호스트 브라우저를 대상으로 지정합니다.

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

또는 업데이트를 게시하는 에이전트에 대해 샌드박싱을 비활성화합니다.
