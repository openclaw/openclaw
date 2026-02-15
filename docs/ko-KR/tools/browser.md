---
summary: "Integrated browser control service + action commands"
read_when:
  - Adding agent-controlled browser automation
  - Debugging why openclaw is interfering with your own Chrome
  - Implementing browser settings + lifecycle in the macOS app
title: "Browser (OpenClaw-managed)"
x-i18n:
  source_hash: f07c06bd6b99908979bd8767eae4009cbf306bf121da20a0bab39d6a4b103169
---

# 브라우저(openclaw 관리)

OpenClaw는 에이전트가 제어하는 **전용 Chrome/Brave/Edge/Chromium 프로필**을 실행할 수 있습니다.
귀하의 개인 브라우저와 격리되어 소규모 로컬을 통해 관리됩니다.
게이트웨이 내부의 제어 서비스(루프백에만 해당)

초보자용 보기:

- **별도의 에이전트 전용 브라우저**라고 생각하세요.
- `openclaw` 프로필은 개인 브라우저 프로필을 **건드리지** 않습니다.
- 상담원은 안전한 차선에서 **탭 열기, 페이지 읽기, 클릭 및 입력**을 할 수 있습니다.
- 기본 `chrome` 프로필은 **시스템 기본 Chromium 브라우저**를 사용합니다.
  확장 릴레이; 격리된 관리 브라우저의 경우 `openclaw`로 전환합니다.

## 당신이 얻는 것

- **openclaw**라는 별도의 브라우저 프로필(기본적으로 주황색 액센트).
- 결정적 탭 제어(목록/열기/초점/닫기).
- 에이전트 작업(클릭/입력/드래그/선택), 스냅샷, 스크린샷, PDF.
- 선택적 다중 프로필 지원(`openclaw`, `work`, `remote`, ...).

이 브라우저는 일일 드라이버가 **아닙니다**. 안전하고 격리된 표면입니다.
에이전트 자동화 및 검증.

## 빠른 시작

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

"브라우저 비활성화"가 발생하면 구성에서 활성화하고(아래 참조)
게이트웨이.

## 프로필: `openclaw` 대 `chrome`

- `openclaw`: 관리되고 격리된 브라우저(확장 필요 없음).
- `chrome`: **시스템 브라우저**로 확장 릴레이(OpenClaw 필요)
  탭에 첨부할 확장명).

기본적으로 관리 모드를 원하면 `browser.defaultProfile: "openclaw"`를 설정하세요.

## 구성

브라우저 설정은 `~/.openclaw/openclaw.json`에 있습니다.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

참고:

- 브라우저 제어 서비스는 `gateway.port`에서 파생된 포트의 루프백에 바인딩됩니다.
  (기본값: `18791`, 게이트웨이 + 2). 릴레이는 다음 포트(`18792`)를 사용합니다.
- 게이트웨이 포트(`gateway.port` 또는 `OPENCLAW_GATEWAY_PORT`)를 재정의하는 경우,
  파생된 브라우저 포트는 동일한 "패밀리"에 유지되도록 이동합니다.
- `cdpUrl`는 설정 해제 시 기본적으로 릴레이 포트로 설정됩니다.
- `remoteCdpTimeoutMs`는 원격(비루프백) CDP 연결 가능성 확인에 적용됩니다.
- `remoteCdpHandshakeTimeoutMs`는 원격 CDP WebSocket 연결 가능성 확인에 적용됩니다.
- `attachOnly: true`는 "로컬 브라우저를 시작하지 마십시오. 이미 실행 중인 경우에만 연결하십시오."를 의미합니다.
- `color` + 프로필별 `color` 브라우저 UI에 색조를 지정하여 어떤 프로필이 활성화되어 있는지 확인할 수 있습니다.
- 기본 프로필은 `chrome`(확장 릴레이)입니다. 관리되는 브라우저는 `defaultProfile: "openclaw"`를 사용하세요.
- 자동 감지 순서: Chromium 기반인 경우 시스템 기본 브라우저; 그렇지 않으면 Chrome → Brave → Edge → Chromium → Chrome Canary.
- 로컬 `openclaw` 프로필 자동 할당 `cdpPort`/`cdpUrl` — 원격 CDP에 대해서만 설정합니다.

## Brave(또는 다른 Chromium 기반 브라우저)를 사용하세요.

**시스템 기본** 브라우저가 Chromium 기반(Chrome/Brave/Edge/etc)인 경우,
OpenClaw는 이를 자동으로 사용합니다. 재정의하려면 `browser.executablePath`를 설정하세요.
자동 감지:

CLI 예:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## 로컬 대 원격 제어

- **로컬 제어(기본값):** 게이트웨이가 루프백 제어 서비스를 시작하고 로컬 브라우저를 시작할 수 있습니다.
- **원격 제어(노드 호스트):** 브라우저가 있는 시스템에서 노드 호스트를 실행합니다. 게이트웨이는 브라우저 작업을 프록시로 프록시합니다.
- **원격 CDP:** `browser.profiles.<name>.cdpUrl`(또는 `browser.cdpUrl`)를 다음으로 설정합니다.
  원격 Chromium 기반 브라우저에 연결합니다. 이 경우 OpenClaw는 로컬 브라우저를 시작하지 않습니다.

원격 CDP URL에는 인증이 포함될 수 있습니다.

- 쿼리 토큰(예: `https://provider.example?token=<token>`)
- HTTP 기본 인증(예: `https://user:pass@provider.example`)

OpenClaw는 `/json/*` 엔드포인트를 호출하고 연결할 때 인증을 유지합니다.
CDP 웹소켓에. 환경 변수나 보안 비밀 관리자를 선호하세요.
구성 파일에 커밋하는 대신 토큰을 사용하세요.

## 노드 브라우저 프록시(제로 구성 기본값)

브라우저가 있는 머신에서 **노드 호스트**를 실행하면 OpenClaw는 다음을 수행할 수 있습니다.
추가 브라우저 구성 없이 해당 노드에 대한 브라우저 도구 호출을 자동 라우팅합니다.
이는 원격 게이트웨이의 기본 경로입니다.

참고:

- 노드 호스트는 **프록시 명령**을 통해 로컬 브라우저 제어 서버를 노출합니다.
- 프로필은 노드 자체의 `browser.profiles` 구성에서 나옵니다(로컬과 동일).
- 원하지 않으면 비활성화하세요.
  - 노드에서: `nodeHost.browserProxy.enabled=false`
  - 게이트웨이에서: `gateway.nodes.browser.mode="off"`

## 브라우저리스(호스팅 원격 CDP)

[브라우저리스](https://browserless.io)는 호스팅된 Chromium 서비스입니다.
HTTPS를 통한 CDP 엔드포인트. OpenClaw 브라우저 프로필을 다음 위치에 지정할 수 있습니다.
브라우저리스 지역 엔드포인트를 확인하고 API 키로 인증하세요.

예:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

참고:

- `<BROWSERLESS_API_KEY>`를 실제 브라우저리스 토큰으로 바꾸세요.
- 브라우저리스 계정과 일치하는 지역 엔드포인트를 선택하세요(해당 문서 참조).

## 보안

주요 아이디어:

- 브라우저 제어는 루프백 전용입니다. 액세스는 게이트웨이의 인증 또는 노드 페어링을 통해 진행됩니다.
- 브라우저 제어가 활성화되어 있고 인증이 구성되지 않은 경우 OpenClaw는 시작 시 `gateway.auth.token`를 자동 생성하고 이를 구성에 유지합니다.
- 게이트웨이와 모든 노드 호스트를 개인 네트워크(Tailscale)에 유지합니다. 공개 노출을 피하십시오.
- 원격 CDP URL/토큰을 비밀로 취급합니다. 환경 변수 또는 비밀 관리자를 선호합니다.

원격 CDP 팁:

- 가능한 경우 HTTPS 엔드포인트와 단기 토큰을 선호하세요.
- 수명이 긴 토큰을 구성 파일에 직접 삽입하지 마세요.

## 프로필(멀티 브라우저)

OpenClaw는 여러 명명된 프로필(라우팅 구성)을 지원합니다. 프로필은 다음과 같습니다.

- **openclaw-managed**: 자체 사용자 데이터 디렉터리 + CDP 포트가 있는 전용 Chromium 기반 브라우저 인스턴스
- **원격**: 명시적인 CDP URL(다른 곳에서 실행되는 Chromium 기반 브라우저)
- **확장 릴레이**: 로컬 릴레이 + Chrome 확장 프로그램을 통한 기존 Chrome 탭

기본값:

- `openclaw` 프로필이 누락된 경우 자동 생성됩니다.
- `chrome` 프로필은 Chrome 확장 릴레이에 내장되어 있습니다(기본적으로 `http://127.0.0.1:18792`를 가리킴).
- 로컬 CDP 포트는 기본적으로 **18800~18899**에서 할당됩니다.
- 프로필을 삭제하면 해당 로컬 데이터 디렉터리가 휴지통으로 이동됩니다.

모든 제어 엔드포인트는 `?profile=<name>`를 허용합니다. CLI는 `--browser-profile`를 사용합니다.

## Chrome 확장 프로그램 릴레이(기존 Chrome 사용)

OpenClaw는 로컬 CDP 릴레이 + Chrome 확장 프로그램을 통해 **기존 Chrome 탭**(별도의 "openclaw" Chrome 인스턴스 없음)을 구동할 수도 있습니다.

전체 가이드: [Chrome 확장 프로그램](/tools/chrome-extension)

흐름:

- 게이트웨이는 로컬(동일한 시스템)에서 실행되거나 노드 호스트가 브라우저 시스템에서 실행됩니다.
- 로컬 **릴레이 서버**는 루프백 `cdpUrl`(기본값: `http://127.0.0.1:18792`)에서 수신 대기합니다.
- 탭에서 **OpenClaw Browser Relay** 확장 아이콘을 클릭하여 연결합니다. (자동으로 연결되지는 않습니다.)
- 에이전트는 올바른 프로필을 선택하여 일반 `browser` 도구를 통해 해당 탭을 제어합니다.

게이트웨이가 다른 곳에서 실행되는 경우 게이트웨이가 브라우저 작업을 프록시할 수 있도록 브라우저 시스템에서 노드 호스트를 실행합니다.

### 샌드박스 세션

에이전트 세션이 샌드박스 처리된 경우 `browser` 도구는 기본적으로 `target="sandbox"`(샌드박스 브라우저)로 설정될 수 있습니다.
Chrome 확장 릴레이 인수에는 호스트 브라우저 제어가 필요하므로 다음 중 하나를 수행합니다.

- 샌드박스 처리되지 않은 세션을 실행하거나
- 도구를 호출할 때 `agents.defaults.sandbox.browser.allowHostControl: true`를 설정하고 `target="host"`를 사용합니다.

### 설정

1. 확장 프로그램을 로드합니다(dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → '개발자 모드' 활성화
- “Load unpacked” → `openclaw browser extension path`로 출력된 디렉토리 선택
- 확장 프로그램을 고정한 다음 제어하려는 탭에서 클릭하세요(배지에 `ON`가 표시됨).

2. 사용:

- CLI: `openclaw browser --browser-profile chrome tabs`
- 에이전트 도구: `browser` 및 `profile="chrome"`

선택 사항: 다른 이름이나 릴레이 포트를 원하는 경우 고유한 프로필을 만드세요.

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

참고:

- 이 모드는 대부분의 작업(스크린샷/스냅샷/액션)에 대해 Playwright-on-CDP를 사용합니다.
- 확장 아이콘을 다시 클릭하여 분리하세요.

## 격리 보장

- **전용 사용자 데이터 디렉토리**: 개인 브라우저 프로필을 절대 건드리지 않습니다.
- **전용 포트**: 개발 워크플로와의 충돌을 방지하기 위해 `9222`를 방지합니다.
- **결정적 탭 제어**: "마지막 탭"이 아닌 `targetId`로 탭을 타겟팅합니다.

## 브라우저 선택

로컬로 시작할 때 OpenClaw는 사용 가능한 첫 번째 항목을 선택합니다.

1. 크롬
2. 용감한
3. 엣지
4. 크롬
5. 크롬 카나리아

`browser.executablePath`로 무시할 수 있습니다.

플랫폼:

- macOS: `/Applications` 및 `~/Applications`를 확인합니다.
- Linux: `google-chrome`, `brave`, `microsoft-edge`, `chromium` 등을 찾습니다.
- Windows: 일반적인 설치 위치를 확인합니다.

## 제어 API(선택 사항)

로컬 통합의 경우에만 게이트웨이는 작은 루프백 HTTP API를 노출합니다.

- 상태/시작/중지: `GET /`, `POST /start`, `POST /stop`
- 탭: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- 스냅샷/스크린샷: `GET /snapshot`, `POST /screenshot`
- 동작: `POST /navigate`, `POST /act`
- 후크: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- 다운로드: `POST /download`, `POST /wait/download`
- 디버깅: `GET /console`, `POST /pdf`
- 디버깅: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- 네트워크 : `POST /response/body`
- 상태: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- 상태: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- 설정: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

모든 엔드포인트는 `?profile=<name>`를 허용합니다.

게이트웨이 인증이 구성된 경우 브라우저 HTTP 경로에도 인증이 필요합니다.

- `Authorization: Bearer <gateway token>`
- `x-openclaw-password: <gateway password>` 또는 해당 비밀번호를 사용한 HTTP 기본 인증

### 극작가 요구사항

일부 기능(탐색/작업/AI 스냅샷/역할 스냅샷, 요소 스크린샷, PDF)에는
극작가. Playwright가 설치되지 않은 경우 해당 엔드포인트는 명확한 501을 반환합니다.
오류. ARIA 스냅샷과 기본 스크린샷은 openclaw 관리 Chrome에서 계속 작동합니다.
Chrome 확장 릴레이 드라이버의 경우 ARIA 스냅샷 및 스크린샷에는 Playwright가 필요합니다.

`Playwright is not available in this gateway build`가 표시되면 전체 설치
Playwright 패키지(`playwright-core` 아님) 및 게이트웨이를 다시 시작하거나 다시 설치
브라우저를 지원하는 OpenClaw.

#### Docker Playwright 설치

게이트웨이가 Docker에서 실행되는 경우 `npx playwright`(npm 재정의 충돌)을 피하세요.
대신 번들 CLI를 사용하십시오.

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

브라우저 다운로드를 유지하려면 `PLAYWRIGHT_BROWSERS_PATH`를 설정합니다(예:
`/home/node/.cache/ms-playwright`) 그리고 `/home/node`가 다음을 통해 지속되는지 확인하세요.
`OPENCLAW_HOME_VOLUME` 또는 바인드 마운트. [Docker](/install/docker)를 참조하세요.

## 작동 방식(내부)

상위 수준 흐름:

- 소규모 **제어 서버**는 HTTP 요청을 수락합니다.
- **CDP**를 통해 Chromium 기반 브라우저(Chrome/Brave/Edge/Chromium)에 연결됩니다.
- 고급 동작(클릭/입력/스냅샷/PDF)의 경우 상단에 **Playwright**를 사용합니다.
  CDP의.
- 극작가가 누락된 경우 극작가 이외의 작업만 가능합니다.

이 디자인은 에이전트를 안정적이고 결정적인 인터페이스에 유지하는 동시에
로컬/원격 브라우저와 프로필을 교환합니다.

## CLI 빠른 참조

모든 명령은 특정 프로필을 대상으로 `--browser-profile <name>`를 허용합니다.
모든 명령은 기계가 읽을 수 있는 출력(안정적인 페이로드)을 위해 `--json`도 허용합니다.

기본사항:

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

검사:

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

작업:

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

상태:

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

참고:

- `upload` 및 `dialog`는 **준비** 호출입니다. 클릭/누르기 전에 실행하세요.
  선택기/대화 상자를 트리거합니다.
- `upload`는 `--input-ref` 또는 `--element`를 통해 직접 파일 입력을 설정할 수도 있습니다.
- `snapshot`:
  - `--format ai` (Playwright가 설치된 경우 기본값): 숫자 참조(`aria-ref="<n>"`)가 포함된 AI 스냅샷을 반환합니다.
  - `--format aria`: 접근성 트리를 반환합니다(참조 없음, 검사만 가능).
  - `--efficient` (또는 `--mode efficient`): 컴팩트 역할 스냅샷 사전 설정(대화형 + 컴팩트 + 깊이 + 낮은 maxChars).
  - 구성 기본값(도구/CLI 전용): 호출자가 모드를 통과하지 못한 경우 효율적인 스냅샷을 사용하려면 `browser.snapshotDefaults.mode: "efficient"`를 설정합니다([게이트웨이 구성](/gateway/configuration#browser-openclaw-managed-browser) 참조).
  - 역할 스냅샷 옵션(`--interactive`, `--compact`, `--depth`, `--selector`)는 `ref=e12`와 같은 참조를 사용하여 역할 기반 스냅샷을 강제합니다.
  - `--frame "<iframe selector>"`는 역할 스냅샷의 범위를 iframe으로 지정합니다(`e12`와 같은 역할 참조와 쌍을 이룹니다).
  - `--interactive` 대화형 요소의 선택하기 쉬운 평면 목록을 출력합니다(운전 작업에 가장 적합).
  - `--labels`는 오버레이된 참조 레이블이 있는 뷰포트 전용 스크린샷을 추가합니다(`MEDIA:<path>` 인쇄).
- `click`/`type`/etc에는 `snapshot`에서 `ref`가 필요합니다(숫자 `12` 또는 역할 참조 `e12`).
  CSS 선택기는 작업에 대해 의도적으로 지원되지 않습니다.

## 스냅샷 및 심판

OpenClaw는 두 가지 "스냅샷" 스타일을 지원합니다.

- **AI 스냅샷(숫자 참조)**: `openclaw browser snapshot` (기본값; `--format ai`)
  - 출력: 숫자 참조를 포함하는 텍스트 스냅샷.
  - 동작: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - 내부적으로는 Playwright의 `aria-ref`를 통해 심판이 해결됩니다.

- **역할 스냅샷(`e12`와 같은 역할 참조)**: `openclaw browser snapshot --interactive` (또는 `--compact`, `--depth`, `--selector`, `--frame`)
  - 출력: `[ref=e12]`(및 선택 사항 `[nth=1]`)가 포함된 역할 기반 목록/트리.
  - 동작: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - 내부적으로 참조는 `getByRole(...)`를 통해 해결됩니다(중복의 경우 `nth()` 추가).
  - 오버레이된 `e12` 라벨이 있는 뷰포트 스크린샷을 포함하려면 `--labels`를 추가하세요.

참조 동작:

- 참조는 **탐색 전반에 걸쳐 안정적이지 않습니다**. 뭔가 실패하면 `snapshot`를 다시 실행하고 새로운 참조를 사용하세요.
- 역할 스냅샷이 `--frame`로 생성된 경우 역할 참조는 다음 역할 스냅샷까지 해당 iframe으로 범위가 지정됩니다.

## 파워업을 기다립니다

시간/텍스트 이상의 것을 기다릴 수 있습니다.

- URL을 기다립니다(Playwright에서 지원하는 글로브):
  - `openclaw browser wait --url "**/dash"`
- 로드 상태 대기:
  - `openclaw browser wait --load networkidle`
- JS 조건자를 기다립니다.
  - `openclaw browser wait --fn "window.ready===true"`
- 선택기가 표시될 때까지 기다립니다.
  - `openclaw browser wait "#main"`

다음과 같이 결합할 수 있습니다.

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## 디버그 작업흐름

작업이 실패하는 경우(예: '표시되지 않음', '엄격 모드 위반', '포함됨'):

1. `openclaw browser snapshot --interactive`
2. `click <ref>` / `type <ref>` 사용(대화형 모드에서 역할 참조 선호)
3. 여전히 실패하는 경우: `openclaw browser highlight <ref>` 극작가의 목표가 무엇인지 확인하세요.
4. 페이지가 이상하게 작동하는 경우:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. 심층 디버깅의 경우: 추적을 기록합니다.
   - `openclaw browser trace start`
   - 문제를 재현
   - `openclaw browser trace stop` (`TRACE:<path>` 인쇄)

## JSON 출력

`--json`는 스크립팅 및 구조화된 도구용입니다.

예:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON의 역할 스냅샷에는 도구가 페이로드 크기와 밀도를 추론할 수 있도록 `refs`와 작은 `stats` 블록(줄/문자/참조/대화형)이 포함되어 있습니다.

## 상태 및 환경 손잡이

이는 "사이트를 X처럼 동작하게 만들기" 작업 흐름에 유용합니다.

- 쿠키: `cookies`, `cookies set`, `cookies clear`
- 저장공간 : `storage local|session get|set|clear`
- 오프라인: `set offline on|off`
- 헤더: `set headers --json '{"X-Debug":"1"}'` (또는 `--clear`)
- HTTP 기본 인증: `set credentials user pass` (또는 `--clear`)
- 위치정보: `set geo <lat> <lon> --origin "https://example.com"` (또는 `--clear`)
- 미디어: `set media dark|light|no-preference|none`
- 시간대/지역: `set timezone ...`, `set locale ...`
- 장치/뷰포트:
  - `set device "iPhone 14"` (극작가 장치 사전 설정)
  - `set viewport 1280 720`

## 보안 및 개인정보 보호

- openclaw 브라우저 프로필에는 로그인된 세션이 포함될 수 있습니다. 민감하게 다루세요.
- `browser act kind=evaluate` / `openclaw browser evaluate` 및 `wait --fn`
  페이지 컨텍스트에서 임의의 JavaScript를 실행합니다. 신속한 주입으로 방향을 잡을 수 있습니다
  이. 필요하지 않은 경우 `browser.evaluateEnabled=false`를 사용하여 비활성화하세요.
- 로그인 및 안티봇 노트(X/트위터 등)는 [브라우저 로그인 + X/트위터 포스팅](/tools/browser-login)을 참고하세요.
- 게이트웨이/노드 호스트를 비공개로 유지합니다(루프백 또는 tailnet 전용).
- 원격 CDP 엔드포인트는 강력합니다. 터널을 만들어 보호하세요.

## 문제 해결

Linux 관련 문제(특히 Chromium 스냅)의 경우 다음을 참조하세요.
[브라우저 문제 해결](/tools/browser-linux-troubleshooting).

## 에이전트 도구 + 제어 작동 방식

에이전트는 브라우저 자동화를 위한 **단일 도구**를 얻습니다.

- `browser` — 상태/시작/중지/탭/열기/초점/닫기/스냅샷/스크린샷/탐색/작동

매핑 방법:

- `browser snapshot`는 안정적인 UI 트리(AI 또는 ARIA)를 반환합니다.
- `browser act`는 스냅샷 `ref` ID를 사용하여 클릭/입력/드래그/선택을 수행합니다.
- `browser screenshot`는 픽셀(전체 페이지 또는 요소)을 캡처합니다.
- `browser`는 다음을 허용합니다:
  - `profile` 명명된 브라우저 프로필(openclaw, chrome 또는 원격 CDP)을 선택합니다.
  - `target` (`sandbox` | `host` | `node`) 브라우저가 있는 위치를 선택합니다.
  - 샌드박스 세션에서 `target: "host"`에는 `agents.defaults.sandbox.browser.allowHostControl=true`가 필요합니다.
  - `target`가 생략된 경우: 샌드박스 세션의 기본값은 `sandbox`이고, 샌드박스가 아닌 세션의 기본값은 `host`입니다.
  - 브라우저 가능 노드가 연결된 경우 `target="host"` 또는 `target="node"`를 고정하지 않으면 도구가 해당 노드로 자동 라우팅될 수 있습니다.

이는 에이전트의 결정성을 유지하고 불안정한 선택기를 방지합니다.
