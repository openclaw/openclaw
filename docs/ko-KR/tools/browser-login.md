---
summary: "브라우저 자동화 및 X/Twitter 게시를 위한 수동 로그인"
read_when:
  - 브라우저 자동화를 위해 사이트에 로그인해야 할 때
  - X/Twitter에 업데이트를 게시하고 싶을 때
title: "브라우저 로그인"
---

# 브라우저 로그인 + X/Twitter 게시

## 수동 로그인 (권장)

사이트 로그인이 필요한 경우, **호스트** 브라우저 프로파일 (openclaw 브라우저)에서 **수동으로 로그인**하십시오.

모델에 자격 증명을 제공하지 **마십시오**. 자동 로그인은 종종 봇 방어를 트리거하여 계정을 잠글 수 있습니다.

메인 브라우저 문서로 돌아가기: [브라우저](/tools/browser).

## 어떤 Chrome 프로파일이 사용되나요?

OpenClaw는 **전용 Chrome 프로파일**(`openclaw`, 주황색 UI)이 있으며, 이는 일상적으로 사용하는 브라우저 프로파일과 별개입니다.

접근하는 두 가지 방법:

1. **에이전트에게 브라우저를 열어달라고 요청**한 다음 직접 로그인하십시오.
2. **CLI를 통해 열기**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

여러 프로파일이 있다면, `--browser-profile <name>`을 사용하십시오 (기본값은 `openclaw`).

## X/Twitter: 권장 흐름

- **읽기/검색/스레드:** **호스트** 브라우저를 사용 (수동 로그인).
- **업데이트 게시:** **호스트** 브라우저를 사용 (수동 로그인).

## 샌드박스 격리 + 호스트 브라우저 접근

샌드박스 격리 브라우저 세션은 **봇 감지를 촉발할 가능성**이 더 높습니다. X/Twitter(및 다른 엄격한 사이트)에서는 **호스트** 브라우저를 선호하십시오.

에이전트가 샌드박스 격리된 경우, 브라우저 도구는 기본적으로 샌드박스 격리를 사용합니다. 호스트 제어를 허용하려면:

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

그런 다음 호스트 브라우저를 대상으로 하십시오:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

또는 업데이트를 게시하는 에이전트에 대한 샌드박스 격리를 비활성화하십시오.
