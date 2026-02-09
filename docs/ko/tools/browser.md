---
summary: "통합 브라우저 제어 서비스 + 액션 명령"
read_when:
  - 에이전트 제어 브라우저 자동화를 추가할 때
  - openclaw 가 자신의 Chrome 에 간섭하는 이유를 디버깅할 때
  - macOS 앱에서 브라우저 설정 + 라이프사이클을 구현할 때
title: "Browser (OpenClaw 관리)"
---

# Browser (openclaw-managed)

OpenClaw 는 에이전트가 제어하는 **전용 Chrome/Brave/Edge/Chromium 프로필**을 실행할 수 있습니다.
이는 개인 브라우저와 분리되어 있으며 Gateway(게이트웨이) 내부의 작은 로컬
제어 서비스(루프백 전용)를 통해 관리됩니다.

초보자 관점:

- **에이전트 전용의 별도 브라우저**라고 생각하면 됩니다.
- `openclaw` 프로필은 개인 브라우저 프로필에 **전혀** 영향을 주지 않습니다.
- 에이전트는 안전한 환경에서 **탭 열기, 페이지 읽기, 클릭, 타이핑**을 수행할 수 있습니다.
- 기본 `chrome` 프로필은 확장 릴레이를 통해 **시스템 기본 Chromium 브라우저**를 사용합니다. 격리된 관리형 브라우저를 사용하려면 `openclaw` 로 전환하십시오.

## 얻을 수 있는 것

- **openclaw** 라는 이름의 별도 브라우저 프로필(기본 오렌지 색상 강조).
- 결정론적인 탭 제어(목록/열기/포커스/닫기).
- 에이전트 액션(클릭/타이핑/드래그/선택), 스냅샷, 스크린샷, PDF.
- 선택적 다중 프로필 지원(`openclaw`, `work`, `remote`, ...).

이 브라우저는 **일상적으로 사용하는 브라우저가 아닙니다**. 에이전트 자동화와 검증을 위한 안전하고 격리된 표면입니다.

## 빠른 시작

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

“Browser disabled” 가 표시되면, 설정에서 이를 활성화한 뒤 Gateway 를 재시작하십시오
(아래 참조).

## 프로필: `openclaw` vs `chrome`

- `openclaw`: 관리형, 격리된 브라우저(확장 불필요).
- `chrome`: **시스템 브라우저**에 대한 확장 릴레이(OpenClaw
  확장을 탭에 연결해야 함).

기본적으로 관리형 모드를 사용하려면 `browser.defaultProfile: "openclaw"` 을 설정하십시오.

## 구성

브라우저 설정은 `~/.openclaw/openclaw.json` 에 있습니다.

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

참고 사항:

- 브라우저 제어 서비스는 `gateway.port` 에서 파생된 포트의 루프백에 바인딩됩니다
  (기본값: `18791`, 즉 gateway + 2). 릴레이는 다음 포트(`18792`)를 사용합니다.
- Gateway 포트(`gateway.port` 또는 `OPENCLAW_GATEWAY_PORT`)를 재정의하면,
  파생된 브라우저 포트도 같은 “패밀리”를 유지하도록 이동합니다.
- `cdpUrl` 는 설정되지 않은 경우 릴레이 포트를 기본값으로 사용합니다.
- `remoteCdpTimeoutMs` 는 원격(비 루프백) CDP 도달성 검사에 적용됩니다.
- `remoteCdpHandshakeTimeoutMs` 는 원격 CDP WebSocket 도달성 검사에 적용됩니다.
- `attachOnly: true` 은 “로컬 브라우저를 절대 실행하지 않고, 이미 실행 중인 경우에만 연결”을 의미합니다.
- `color` + 프로필별 `color` 는 활성 프로필을 식별할 수 있도록 브라우저 UI 를 착색합니다.
- 기본 프로필은 `chrome` (확장 릴레이)입니다. 관리형 브라우저에는 `defaultProfile: "openclaw"` 를 사용하십시오.
- 자동 감지 순서: Chromium 기반 시스템 기본 브라우저 → Chrome → Brave → Edge → Chromium → Chrome Canary.
- 로컬 `openclaw` 프로필은 `cdpPort`/`cdpUrl` 를 자동 할당합니다. 원격 CDP 에서만 이를 설정하십시오.

## Brave (또는 다른 Chromium 기반 브라우저) 사용

**시스템 기본** 브라우저가 Chromium 기반(Chrome/Brave/Edge 등)인 경우,
OpenClaw 는 이를 자동으로 사용합니다. 자동 감지를 재정의하려면
`browser.executablePath` 을 설정하십시오.

CLI 예시:

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

## 로컬 vs 원격 제어

- **로컬 제어(기본값):** Gateway 가 루프백 제어 서비스를 시작하고 로컬 브라우저를 실행할 수 있습니다.
- **원격 제어(노드 호스트):** 브라우저가 있는 머신에서 노드 호스트를 실행하면,
  Gateway 가 브라우저 액션을 해당 노드로 프록시합니다.
- **원격 CDP:** `browser.profiles.<name>.cdpUrl` (또는 `browser.cdpUrl`)를 설정하여
  원격 Chromium 기반 브라우저에 연결합니다. 이 경우 OpenClaw 는 로컬 브라우저를 실행하지 않습니다.

원격 CDP URL 은 인증을 포함할 수 있습니다:

- 쿼리 토큰(예: `https://provider.example?token=<token>`)
- HTTP Basic 인증(예: `https://user:pass@provider.example`)

OpenClaw 는 `/json/*` 엔드포인트를 호출할 때와
CDP WebSocket 에 연결할 때 인증을 유지합니다. 토큰은 설정 파일에 커밋하지 말고 환경 변수나 시크릿 매니저 사용을 권장합니다.

## 노드 브라우저 프록시(무설정 기본)

브라우저가 있는 머신에서 **노드 호스트**를 실행하면,
OpenClaw 는 추가 브라우저 설정 없이도 브라우저 도구 호출을 해당 노드로 자동 라우팅할 수 있습니다.
이는 원격 Gateway 의 기본 경로입니다.

참고 사항:

- 노드 호스트는 **프록시 명령**을 통해 로컬 브라우저 제어 서버를 노출합니다.
- 프로필은 노드 자체의 `browser.profiles` 설정에서 가져옵니다(로컬과 동일).
- 사용하지 않으려면 비활성화할 수 있습니다:
  - 노드에서: `nodeHost.browserProxy.enabled=false`
  - Gateway 에서: `gateway.nodes.browser.mode="off"`

## Browserless (호스팅된 원격 CDP)

[Browserless](https://browserless.io)는 HTTPS 를 통해
CDP 엔드포인트를 노출하는 호스팅 Chromium 서비스입니다. OpenClaw 브라우저 프로필을 Browserless 지역 엔드포인트로 지정하고
API 키로 인증할 수 있습니다.

예시:

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

참고 사항:

- `<BROWSERLESS_API_KEY>` 을 실제 Browserless 토큰으로 교체하십시오.
- Browserless 계정에 맞는 지역 엔드포인트를 선택하십시오(자세한 내용은 해당 문서 참고).

## 보안

핵심 개념:

- 브라우저 제어는 루프백 전용이며, 접근은 Gateway 인증 또는 노드 페어링을 통해 흐릅니다.
- Gateway 와 모든 노드 호스트는 사설 네트워크(Tailscale)에 유지하고, 공개 노출을 피하십시오.
- 원격 CDP URL/토큰은 비밀로 취급하세요; 환경 변수나 시크릿 매니저 사용을 권장합니다.

원격 CDP 팁:

- 가능하면 HTTPS 엔드포인트와 단기 토큰을 사용하십시오.
- 장기 토큰을 설정 파일에 직접 포함하지 마십시오.

## 프로필(다중 브라우저)

OpenClaw 는 여러 개의 이름 있는 프로필(라우팅 설정)을 지원합니다. 프로필 유형:

- **openclaw-managed**: 전용 사용자 데이터 디렉토리 + CDP 포트를 가진 Chromium 기반 브라우저 인스턴스
- **remote**: 명시적인 CDP URL(다른 위치에서 실행 중인 Chromium 기반 브라우저)
- **extension relay**: 로컬 릴레이 + Chrome 확장을 통한 기존 Chrome 탭

기본값:

- `openclaw` 프로필은 없을 경우 자동 생성됩니다.
- `chrome` 프로필은 Chrome 확장 릴레이용 내장 프로필입니다
  (기본적으로 `http://127.0.0.1:18792` 을 가리킵니다).
- 로컬 CDP 포트는 기본적으로 **18800–18899** 범위에서 할당됩니다.
- 프로필을 삭제하면 로컬 데이터 디렉토리는 휴지통으로 이동합니다.

모든 제어 엔드포인트는 `?profile=<name>` 을 허용하며,
CLI 는 `--browser-profile` 를 사용합니다.

## Chrome 확장 릴레이(기존 Chrome 사용)

OpenClaw 는 로컬 CDP 릴레이 + Chrome 확장을 통해
**기존 Chrome 탭**을 제어할 수도 있습니다
(별도의 “openclaw” Chrome 인스턴스 없음).

전체 가이드: [Chrome extension](/tools/chrome-extension)

흐름:

- Gateway 가 로컬(같은 머신)에서 실행되거나,
  브라우저 머신에서 노드 호스트가 실행됩니다.
- 로컬 **릴레이 서버**가 루프백 `cdpUrl` 에서 수신합니다(기본값: `http://127.0.0.1:18792`).
- 제어할 탭에서 **OpenClaw Browser Relay** 확장 아이콘을 클릭하여 연결합니다
  (자동 연결되지 않습니다).
- 에이전트는 올바른 프로필을 선택하여 일반 `browser` 도구로 해당 탭을 제어합니다.

Gateway 가 다른 곳에서 실행되는 경우,
Gateway 가 브라우저 액션을 프록시할 수 있도록 브라우저 머신에서 노드 호스트를 실행하십시오.

### 샌드박스 세션

에이전트 세션이 샌드박스화된 경우,
`browser` 도구는 기본적으로 `target="sandbox"` (샌드박스 브라우저)를 사용할 수 있습니다.
Chrome 확장 릴레이 인수는 호스트 브라우저 제어가 필요하므로 다음 중 하나를 수행하십시오:

- 세션을 비샌드박스 상태로 실행하거나
- `agents.defaults.sandbox.browser.allowHostControl: true` 을 설정하고 도구 호출 시 `target="host"` 를 사용하십시오.

### 설정

1. 확장 로드(dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → “Developer mode” 활성화
- “Load unpacked” → `openclaw browser extension path` 에 출력된 디렉토리 선택
- 확장을 고정한 뒤 제어할 탭에서 클릭합니다(배지에 `ON` 표시).

2. 사용:

- CLI: `openclaw browser --browser-profile chrome tabs`
- 에이전트 도구: `browser` 와 `profile="chrome"`

선택 사항: 다른 이름이나 릴레이 포트를 원하면 자체 프로필을 생성하십시오:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

참고 사항:

- 이 모드는 대부분의 작업(스크린샷/스냅샷/액션)에 Playwright-on-CDP 를 사용합니다.
- 확장 아이콘을 다시 클릭하면 분리됩니다.

## 격리 보장

- **전용 사용자 데이터 디렉토리**: 개인 브라우저 프로필에 전혀 접근하지 않습니다.
- **전용 포트**: 개발 워크플로와의 충돌을 방지하기 위해 `9222` 을 피합니다.
- **결정론적 탭 제어**: “마지막 탭”이 아닌 `targetId` 으로 탭을 지정합니다.

## 브라우저 선택

로컬에서 실행 시 OpenClaw 는 사용 가능한 항목 중 첫 번째를 선택합니다:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

`browser.executablePath` 으로 재정의할 수 있습니다.

플랫폼별:

- macOS: `/Applications` 및 `~/Applications` 확인.
- Linux: `google-chrome`, `brave`, `microsoft-edge`, `chromium` 등 탐색.
- Windows: 일반적인 설치 경로 확인.

## 제어 API(선택 사항)

로컬 통합 전용으로, Gateway 는 작은 루프백 HTTP API 를 노출합니다:

- 상태/시작/중지: `GET /`, `POST /start`, `POST /stop`
- 탭: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- 스냅샷/스크린샷: `GET /snapshot`, `POST /screenshot`
- 액션: `POST /navigate`, `POST /act`
- 훅: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- 다운로드: `POST /download`, `POST /wait/download`
- 디버깅: `GET /console`, `POST /pdf`
- 디버깅: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- 네트워크: `POST /response/body`
- 상태: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- 상태: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- 설정: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

모든 엔드포인트는 `?profile=<name>` 을 허용합니다.

### Playwright 요구 사항

일부 기능(navigate/act/AI 스냅샷/role 스냅샷, 요소 스크린샷, PDF)은
Playwright 가 필요합니다. Playwright 가 설치되어 있지 않으면,
해당 엔드포인트는 명확한 501 오류를 반환합니다. openclaw-managed Chrome 에서는 ARIA 스냅샷과 기본 스크린샷은 계속 동작합니다.
Chrome 확장 릴레이 드라이버의 경우, ARIA 스냅샷과 스크린샷에도 Playwright 가 필요합니다.

`Playwright is not available in this gateway build` 이 보이면,
전체 Playwright 패키지(`playwright-core` 가 아님)를 설치한 뒤
Gateway 를 재시작하거나, 브라우저 지원을 포함하여 OpenClaw 를 재설치하십시오.

#### Docker Playwright 설치

Gateway 가 Docker 에서 실행되는 경우,
`npx playwright` 를 피하십시오(npm 오버라이드 충돌).
대신 번들된 CLI 를 사용하십시오:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

브라우저 다운로드를 영구 저장하려면 `PLAYWRIGHT_BROWSERS_PATH` 을 설정하고
(예: `/home/node/.cache/ms-playwright`),
`/home/node` 이 `OPENCLAW_HOME_VOLUME` 또는 바인드 마운트를 통해
영구화되어 있는지 확인하십시오. 자세한 내용은 [Docker](/install/docker)를 참조하십시오.

## 동작 방식(내부)

상위 수준 흐름:

- 작은 **제어 서버**가 HTTP 요청을 수신합니다.
- **CDP** 를 통해 Chromium 기반 브라우저(Chrome/Brave/Edge/Chromium)에 연결합니다.
- 고급 액션(클릭/타이핑/스냅샷/PDF)을 위해 CDP 위에서 **Playwright** 를 사용합니다.
- Playwright 가 없는 경우, 비 Playwright 작업만 사용할 수 있습니다.

이 설계는 에이전트에 안정적이고 결정론적인 인터페이스를 제공하면서,
로컬/원격 브라우저와 프로필을 자유롭게 교체할 수 있게 합니다.

## CLI 빠른 참조

모든 명령은 특정 프로필을 지정하기 위해 `--browser-profile <name>` 을 허용합니다.
또한 모든 명령은 기계 판독 가능한 출력(안정적인 페이로드)을 위해 `--json` 을 허용합니다.

기본:

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

액션:

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

참고 사항:

- `upload` 및 `dialog` 는 **무장(arming)** 호출입니다. 파일 선택기/다이얼로그를 트리거하는 클릭/프레스 전에 실행하십시오.
- `upload` 는 `--input-ref` 또는 `--element` 를 통해
  파일 입력을 직접 설정할 수도 있습니다.
- `snapshot`:
  - `--format ai` (Playwright 설치 시 기본값): 숫자 참조(`aria-ref="<n>"`)가 포함된 AI 스냅샷을 반환합니다.
  - `--format aria`: 접근성 트리를 반환합니다(참조 없음, 검사 전용).
  - `--efficient` (또는 `--mode efficient`): 컴팩트 역할 스냅샷 프리셋
    (인터랙티브 + 컴팩트 + 깊이 + 낮은 maxChars).
  - 구성 기본값(도구/CLI 전용): 호출자가 모드를 전달하지 않을 때
    효율적인 스냅샷을 사용하려면 `browser.snapshotDefaults.mode: "efficient"` 을 설정하십시오
    ([Gateway 구성](/gateway/configuration#browser-openclaw-managed-browser) 참조).
  - 역할 스냅샷 옵션(`--interactive`, `--compact`, `--depth`, `--selector`)은
    `ref=e12` 와 같은 참조를 가진 역할 기반 스냅샷을 강제합니다.
  - `--frame "<iframe selector>"` 은 역할 스냅샷을 iframe 으로 범위 지정합니다
    (역할 참조 `e12` 와 함께 사용).
  - `--interactive` 는 인터랙티브 요소의 평면적이고 선택하기 쉬운 목록을 출력합니다
    (액션 구동에 최적).
  - `--labels` 은 오버레이된 참조 라벨이 포함된 뷰포트 전용 스크린샷을 추가합니다
    (`MEDIA:<path>` 출력).
- `click`/`type`/등은
  `snapshot` 에서 가져온 `ref` 이 필요합니다
  (숫자 `12` 또는 역할 참조 `e12`).
  액션에서는 CSS 선택자를 의도적으로 지원하지 않습니다.

## 스냅샷과 참조

OpenClaw 는 두 가지 “스냅샷” 스타일을 지원합니다:

- **AI 스냅샷(숫자 참조)**: `openclaw browser snapshot` (기본값; `--format ai`)
  - 출력: 숫자 참조가 포함된 텍스트 스냅샷.
  - 액션: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - 내부적으로 참조는 Playwright 의 `aria-ref` 을 통해 해석됩니다.

- **역할 스냅샷(`e12` 와 같은 역할 참조)**:
  `openclaw browser snapshot --interactive` (또는 `--compact`, `--depth`, `--selector`, `--frame`)
  - 출력: `[ref=e12]` (및 선택적 `[nth=1]`)가 포함된 역할 기반 목록/트리.
  - 액션: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - 내부적으로 참조는 `getByRole(...)` (중복 시 `nth()`)를 통해 해석됩니다.
  - 오버레이된 `e12` 라벨이 있는 뷰포트 스크린샷을 포함하려면
    `--labels` 을 추가하십시오.

참조 동작:

- 참조는 **내비게이션 간에 안정적이지 않습니다**. 실패 시 `snapshot` 을 다시 실행하고 새로운 참조를 사용하십시오.
- 역할 스냅샷이 `--frame` 로 생성된 경우,
  다음 역할 스냅샷까지 역할 참조는 해당 iframe 범위로 제한됩니다.

## 대기 파워업

시간/텍스트 외에도 대기할 수 있습니다:

- URL 대기(Playwright 글로브 지원):
  - `openclaw browser wait --url "**/dash"`
- 로드 상태 대기:
  - `openclaw browser wait --load networkidle`
- JS 조건 대기:
  - `openclaw browser wait --fn "window.ready===true"`
- 선택자가 표시될 때까지 대기:
  - `openclaw browser wait "#main"`

이들은 조합할 수 있습니다:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## 디버그 워크플로

액션이 실패할 때(예: “not visible”, “strict mode violation”, “covered”):

1. `openclaw browser snapshot --interactive`
2. `click <ref>` / `type <ref>` 사용(인터랙티브 모드에서는 역할 참조 권장)
3. 여전히 실패하면: Playwright 가 무엇을 대상으로 하는지 확인하기 위해 `openclaw browser highlight <ref>`
4. 페이지 동작이 이상한 경우:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. 심층 디버깅: 트레이스 기록:
   - `openclaw browser trace start`
   - 문제 재현
   - `openclaw browser trace stop` (`TRACE:<path>` 출력)

## JSON 출력

`--json` 은 스크립팅 및 구조화된 도구를 위한 것입니다.

예시:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON 의 역할 스냅샷에는 `refs` 와 함께,
도구가 페이로드 크기와 밀도를 추론할 수 있도록
작은 `stats` 블록(라인/문자/참조/인터랙티브)이 포함됩니다.

## 상태 및 환경 노브

“사이트를 X 처럼 동작하게 만들기” 워크플로에 유용합니다:

- 쿠키: `cookies`, `cookies set`, `cookies clear`
- 스토리지: `storage local|session get|set|clear`
- 오프라인: `set offline on|off`
- 헤더: `set headers --json '{"X-Debug":"1"}'` (또는 `--clear`)
- HTTP 기본 인증: `set credentials user pass` (또는 `--clear`)
- 지리 위치: `set geo <lat> <lon> --origin "https://example.com"` (또는 `--clear`)
- 미디어: `set media dark|light|no-preference|none`
- 타임존 / 로케일: `set timezone ...`, `set locale ...`
- 디바이스 / 뷰포트:
  - `set device "iPhone 14"` (Playwright 디바이스 프리셋)
  - `set viewport 1280 720`

## 보안 및 개인정보

- openclaw 브라우저 프로필에는 로그인된 세션이 포함될 수 있으므로 민감하게 취급하십시오.
- `browser act kind=evaluate` / `openclaw browser evaluate` 및 `wait --fn` 는
  페이지 컨텍스트에서 임의의 JavaScript 를 실행합니다. 프롬프트 인젝션이 이를 유도할 수 있습니다. 필요하지 않다면 `browser.evaluateEnabled=false` 으로 비활성화하십시오.
- 로그인 및 안티봇 참고 사항(X/Twitter 등)은
  [Browser login + X/Twitter posting](/tools/browser-login)을 참조하십시오.
- Gateway/노드 호스트는 비공개로 유지하십시오(루프백 또는 tailnet 전용).
- 원격 CDP 엔드포인트는 강력하므로, 터널링하고 보호하십시오.

## 문제 해결

Linux 관련 문제(특히 snap Chromium)의 경우,
[Browser troubleshooting](/tools/browser-linux-troubleshooting)을 참조하십시오.

## 에이전트 도구 + 제어 방식

에이전트는 브라우저 자동화를 위해 **하나의 도구**를 사용합니다:

- `browser` — 상태/시작/중지/탭/열기/포커스/닫기/스냅샷/스크린샷/내비게이션/액션

매핑 방식:

- `browser snapshot` 는 안정적인 UI 트리(AI 또는 ARIA)를 반환합니다.
- `browser act` 는 스냅샷 `ref` ID 를 사용하여 클릭/타이핑/드래그/선택을 수행합니다.
- `browser screenshot` 는 픽셀을 캡처합니다(전체 페이지 또는 요소).
- `browser` 는 다음을 허용합니다:
  - 이름 있는 브라우저 프로필(openclaw, chrome, 또는 원격 CDP)을 선택하기 위한 `profile`.
  - 브라우저 위치를 선택하기 위한 `target`
    (`sandbox` | `host` | `node`).
  - 샌드박스 세션에서는 `target: "host"` 에 `agents.defaults.sandbox.browser.allowHostControl=true` 이 필요합니다.
  - `target` 가 생략되면:
    샌드박스 세션은 기본적으로 `sandbox`,
    비샌드박스 세션은 기본적으로 `host` 를 사용합니다.
  - 브라우저 기능이 있는 노드가 연결되어 있으면,
    `target="host"` 또는 `target="node"` 로 고정하지 않는 한
    도구가 자동으로 해당 노드로 라우팅될 수 있습니다.

이를 통해 에이전트는 결정론성을 유지하고,
취약한 선택자를 피할 수 있습니다.
