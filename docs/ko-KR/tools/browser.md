---
summary: "통합 브라우저 제어 서비스 + 동작 명령"
read_when:
  - 에이전트 제어 브라우저 자동화 추가
  - OpenClaw가 자신의 Chrome과 간섭하는 이유 디버깅
  - macOS 앱에서 브라우저 설정 + 라이프사이클 구현
title: "브라우저 (OpenClaw 관리)"
---

# 브라우저 (openclaw-managed)

OpenClaw는 에이전트가 제어하는 **전용 Chrome/Brave/Edge/Chromium 프로파일**을 실행할 수 있습니다.
개인 브라우저와 격리되어 있으며 Gateway 내부의 작은 로컬
제어 서비스를 통해 관리됩니다 (로컬 루프백 전용).

초보자 안내:

- 이를 **별도 에이전트 전용 브라우저**로 생각하십시오.
- `openclaw` 프로파일은 개인 브라우저 프로파일에 **전혀** 영향을 미치지 않습니다.
- 에이전트는 안전한 범위 내에서 **탭 열기, 페이지 읽기, 클릭 및 입력**을 수행할 수 있습니다.
- 기본 `chrome` 프로파일은 **시스템 기본 Chromium 브라우저**를 확장 릴레이를 통해 사용합니다. 격리된 관리 브라우저를 사용하려면 `openclaw`로 전환하십시오.

## 얻을 수 있는 것

- **openclaw**라는 별도의 브라우저 프로파일 (기본적으로 주황색 강조)을 제공합니다.
- 결정론적 탭 제어 (목록/열기/집중/닫기).
- 에이전트 동작 (클릭/입력/드래그/선택), 스냅샷, 스크린샷, PDF.
- 선택적 다중 프로파일 지원 (`openclaw`, `work`, `remote`, ...).

이 브라우저는 **일상적으로 사용하는 브라우저가 아닙니다**. 이는 에이전트 자동화 및 검증을 위한 안전하고 격리된 표면입니다.

## 빠른 시작

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

"브라우저 사용 중지됨"이라는 메시지가 나타나면 아래 설정에서 활성화하고
게이트웨이를 다시 시작하십시오.

## 프로파일: `openclaw` vs `chrome`

- `openclaw`: 관리되고 격리된 브라우저 (확장 필요 없음).
- `chrome`: **시스템 브라우저**에 대한 확장 릴레이 (탭에 연결된 OpenClaw
  확장이 필요함).

기본 모드로 관리 모드를 원하면 `browser.defaultProfile: "openclaw"`를 설정하십시오.

## 구성

브라우저 설정은 `~/.openclaw/openclaw.json`에 저장됩니다.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // 유산 단일 프로파일 오버라이드
    remoteCdpTimeoutMs: 1500, // 원격 CDP HTTP 시간 초과 (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // 원격 CDP 웹소켓 핸드셰이크 시간 초과 (ms)
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

노트:

- 브라우저 제어 서비스는 `gateway.port`에서 유도된 포트에서 로컬 루프백에 바인딩됩니다
  (기본값: `18791`, 이는 게이트웨이 + 2입니다). 릴레이는 다음 포트를 사용합니다 (`18792`).
- 게이트웨이 포트 (`gateway.port` 또는 `OPENCLAW_GATEWAY_PORT`)을 재정의하면,
  파생된 브라우저 포트가 동일한 "가족" 내에 있도록 이동합니다.
- `cdpUrl`은 설정되지 않은 경우 릴레이 포트를 기본값으로 사용합니다.
- `remoteCdpTimeoutMs`는 원격 (비 로컬 루프백) CDP 도달 가능성 확인에 적용됩니다.
- `remoteCdpHandshakeTimeoutMs`는 원격 CDP 웹소켓 도달 가능성 확인에 적용됩니다.
- `attachOnly: true`는 "로컬 브라우저를 실행하지 않고 현재 실행 중인 경우에만 연결합니다."를 의미합니다.
- `color` + 프로파일별 `color`로 브라우저 UI를 착색하여 활성화된 프로파일을 확인할 수 있습니다.
- 기본 프로파일은 `chrome` (확장 릴레이). 관리 브라우저에 `defaultProfile: "openclaw"`를 사용하십시오.
- 자동 감지 순서: Chromium 기반 브라우저가 시스템 기본값인 경우; 그렇지 않으면 Chrome → Brave → Edge → Chromium → Chrome Canary.
- 로컬 `openclaw` 프로파일은 `cdpPort`/`cdpUrl`을 자동 할당합니다 — 이것들은 원격 CDP에만 설정하십시오.

## Brave (또는 다른 Chromium 기반 브라우저) 사용

시스템 기본 브라우저가 Chromium 기반 (Chrome/Brave/Edge 등)인 경우,
OpenClaw는 이를 자동으로 사용합니다. 자동 감지를 재정의하려면 `browser.executablePath`를 설정하십시오:

CLI 예제:

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

- **로컬 제어 (기본값):** 게이트웨이는 로컬 루프백 제어 서비스를 시작하고 로컬 브라우저를 실행할 수 있습니다.
- **원격 제어 (노드 호스트):** 브라우저가 있는 기계에서 노드 호스트를 실행하십시오; 게이트웨이는 브라우저 동작을 그쪽으로 프록시합니다.
- **원격 CDP:** `browser.profiles.<name>.cdpUrl` (또는 `browser.cdpUrl`)을 설정하여
  원격 Chromium 기반 브라우저에 연결하십시오. 이 경우, OpenClaw는 로컬 브라우저를 실행하지 않습니다.

원격 CDP URL은 인증을 포함할 수 있습니다:

- 쿼리 토큰 (예: `https://provider.example?token=<token>`)
- HTTP 기본 인증 (예: `https://user:pass@provider.example`)

OpenClaw는 `/json/*` 엔드포인트와 CDP WebSocket 연결 시 인증 정보를 보존합니다.
토큰을 환경 변수나 비밀 관리자에 저장하는 것이 설정 파일에 직접 저장하는 것보다 좋습니다.

## 노드 브라우저 프록시 (제로 설정 기본값)

브라우저가 있는 기계에서 **노드 호스트**를 실행하면, OpenClaw는
추가적인 브라우저 설정 없이 그 노드로 브라우저 도구 호출을 자동으로 라우팅할 수 있습니다.
이것이 원격 게이트웨이의 기본 경로입니다.

노트:

- 노드 호스트는 로컬 브라우저 제어 서버를 **프록시 명령**을 통해 노출합니다.
- 프로파일은 노드 자체 `browser.profiles` 설정에서 가져옵니다 (로컬과 동일).
- 사용하고 싶지 않다면 비활성화하십시오:
  - 노드에서: `nodeHost.browserProxy.enabled=false`
  - 게이트웨이에서: `gateway.nodes.browser.mode="off"`

## Browserless (호스팅된 원격 CDP)

[Browserless](https://browserless.io)는 HTTPS를 통해
CDP 엔드포인트를 노출하는 호스팅된 Chromium 서비스입니다.
OpenClaw 브라우저 프로파일을 Browserless 지역 엔드포인트에 지정하고
API 키로 인증할 수 있습니다.

예제:

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

노트:

- `<BROWSERLESS_API_KEY>`를 실제 Browserless 토큰으로 교체하십시오.
- Browserless 계정과 일치하는 지역 엔드포인트를 선택하십시오 (문서를 참조하십시오).

## 보안

핵심 아이디어:

- 브라우저 제어는 로컬 루프백 전용입니다; 접근은 게이트웨이의 인증 또는 노드 페어링을 통해 이루어집니다.
- 브라우저 제어가 활성화되고 인증이 구성되지 않은 경우, OpenClaw는 시작 시 `gateway.auth.token`을 자동 생성하고 설정에 저장합니다.
- 게이트웨이 및 노드 호스트를 사설 네트워크 (Tailscale)에서 유지하십시오; 공개 노출을 피하십시오.
- 원격 CDP URL/토큰을 비밀로 취급하십시오; 환경 변수나 비밀 관리자를 사용하는 것이 좋습니다.

원격 CDP 팁:

- 가능한 경우 HTTPS 엔드포인트와 단기 토큰을 선호하십시오.
- 장기 토큰을 설정 파일에 직접 포함하는 것을 피하십시오.

## 프로파일 (다중 브라우저)

OpenClaw는 여러 이름 있는 프로파일 (라우팅 설정)을 지원합니다. 프로파일은 다음과 같습니다:

- **openclaw-managed**: 자체 사용자 데이터 디렉토리와 CDP 포트를 가진 전용 Chromium 기반 브라우저 인스턴스
- **remote**: 명시적인 CDP URL (다른 곳에서 실행 중인 Chromium 기반 브라우저)
- **extension relay**: 로컬 릴레이 + Chrome 확장을 통한 기존 Chrome 탭

기본값:

- `openclaw` 프로파일은 누락된 경우 자동 생성됩니다.
- `chrome` 프로파일은 Chrome 확장 릴레이에 내장되어 있습니다 (기본적으로 `http://127.0.0.1:18792`로 포인트).
- 로컬 CDP 포트는 기본적으로 **18800–18899**에서 할당됩니다.
- 프로파일 삭제 시 로컬 데이터 디렉토리는 휴지통으로 이동합니다.

모든 제어 엔드포인트는 `?profile=<name>`를 허용합니다; CLI는 `--browser-profile`을 사용합니다.

## Chrome 확장 릴레이 (기존 Chrome 사용)

OpenClaw는 로컬 CDP 릴레이 + Chrome 확장을 통해 **기존 Chrome 탭**을 제어할 수도 있습니다 (별도의 "openclaw" Chrome 인스턴스 아님).

전체 가이드: [Chrome 확장](/ko-KR/tools/chrome-extension)

흐름:

- 게이트웨이는 로컬 (동일 기계)에서 실행되거나 브라우저 기계에서 노드 호스트가 실행됩니다.
- 로컬 **릴레이 서버**가 로컬 루프백 `cdpUrl` (기본값: `http://127.0.0.1:18792`)에서 수신합니다.
- 탭을 제어하려면 **OpenClaw Browser Relay** 확장 아이콘을 클릭합니다 (자동 첨부되지 않음).
- 에이전트는 `browser` 도구를 통해 올바른 프로파일을 선택하여 해당 탭을 제어합니다.

게이트웨이가 다른 곳에서 실행되면, 게이트웨이가 브라우저 동작을 좀 더 자유롭게 프록시할 수 있도록 브라우저 기계에서 노드 호스트를 실행하십시오.

### 샌드박스 세션

에이전트 세션이 샌드박스 격리된 경우, `browser` 도구가 `target="sandbox"` (샌드박스 브라우저)로 기본 설정될 수 있습니다.
Chrome 확장 릴레이 인수는 호스트 브라우저 제어가 필요하므로, 다음 중 하나를 수행하십시오:

- 샌드박스되지 않은 상태로 세션 실행, 또는
- `agents.defaults.sandbox.browser.allowHostControl: true`로 설정하고 도구 호출 시 `target="host"`를 사용하십시오.

### 설정

1. 확장 로드 (개발/비압축):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → "개발자 모드" 활성화
- "비압축 로드" → `openclaw browser extension path`에서 출력된 디렉토리를 선택
- 확장을 고정하고 제어할 탭에서 클릭하십시오 (배지가 `ON`으로 표시됨).

2. 사용:

- CLI: `openclaw browser --browser-profile chrome tabs`
- 에이전트 도구: `browser` with `profile="chrome"`

선택 사항: 다른 이름이나 릴레이 포트를 원하면 고유한 프로파일을 생성하십시오:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

노트:

- 이 모드는 대부분의 작업에 대해 Playwright-on-CDP에 의존합니다 (스크린샷/스냅샷/동작).
- 확장 아이콘을 다시 클릭하여 분리하십시오.

## 격리 보장

- **전용 사용자 데이터 디렉토리**: 개인 브라우저 프로파일을 절대 터치하지 않음.
- **전용 포트**: 개발 워크플로와의 충돌을 방지하기 위해 `9222`를 사용하지 않음.
- **결정론적 탭 제어**: "마지막 탭"이 아닌 `targetId`로 탭을 대상으로 합니다.

## 브라우저 선택

로컬에서 실행할 때, OpenClaw는 사용할 수 있는 첫 번째 것을 선택합니다:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

`browser.executablePath`로 재정의할 수 있습니다.

플랫폼:

- macOS: `/Applications` 및 `~/Applications` 확인.
- Linux: `google-chrome`, `brave`, `microsoft-edge`, `chromium` 등을 탐색.
- Windows: 일반 설치 위치 확인.

## 제어 API (선택 사항)

로컬 통합 전용으로, 게이트웨이는 작은 로컬 루프백 HTTP API를 노출합니다:

- 상태/시작/중지: `GET /`, `POST /start`, `POST /stop`
- 탭: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- 스냅샷/스크린샷: `GET /snapshot`, `POST /screenshot`
- 동작: `POST /navigate`, `POST /act`
- 후크: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- 다운로드: `POST /download`, `POST /wait/download`
- 디버깅: `GET /console`, `POST /pdf`
- 디버깅: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- 네트워크: `POST /response/body`
- 상태: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- 상태: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- 설정: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

모든 엔드포인트는 `?profile=<name>`을 허용합니다.

게이트웨이 인증이 구성된 경우, 브라우저 HTTP 경로도 인증이 필요합니다:

- `Authorization: Bearer <gateway token>`
- `x-openclaw-password: <gateway password>` 또는 HTTP 기본 인증을 해당 비밀번호로 설정

### Playwright 필수 사항

일부 기능 (네비게이트/동작/AI 스냅샷/역할 스냅샷, 요소 스크린샷, PDF)은
Playwright가 필요합니다. Playwright가 설치되지 않은 경우, 해당 엔드포인트는 명확한 501
오류를 반환합니다. ARIA 스냅샷과 기본 스크린샷은 openclaw-managed Chrome에서도 작동합니다.
Chrome 확장 릴레이 드라이버의 경우, ARIA 스냅샷과 스크린샷에는 Playwright가 필요합니다.

`Playwright is not available in this gateway build`라는 메시지가 나타나면,
전체 Playwright 패키지를 설치하고 게이트웨이를 다시 시작하거나
브라우저 지원으로 OpenClaw를 다시 설치하십시오.

#### Docker Playwright 설치

게이트웨이가 Docker에서 실행되는 경우, `npx playwright` (npm 오버라이드 충돌을 피하십시오) 대신 번들된 CLI를 사용하십시오:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

브라우저 다운로드를 영구 저장하려면, `PLAYWRIGHT_BROWSERS_PATH`를 설정하고 (예: `/home/node/.cache/ms-playwright`) `/home/node`가 `OPENCLAW_HOME_VOLUME` 또는 바인드 마운트를 통해 영구 저장되는지 확인하십시오. [Docker](/ko-KR/install/docker)를 참조하십시오.

## 작동 방식 (내부)

상위 수준의 흐름:

- 작은 **제어 서버**가 HTTP 요청을 수락합니다.
- Chromium 기반 브라우저 (Chrome/Brave/Edge/Chromium)와 **CDP**를 통해 연결합니다.
- 고급 동작 (클릭/입력/스냅샷/PDF)을 위해서는 **Playwright**를 CDP 위에서 사용합니다.
- Playwright가 없을 때는 Playwright가 아닌 작업만 가능합니다.

이 디자인은 에이전트를 안정적이고 결정론적인 인터페이스로 유지하면서
로컬/원격 브라우저 및 프로파일을 교환할 수 있게 합니다.

## CLI 빠른 참조

모든 명령은 특정 프로파일을 대상으로 `--browser-profile <name>`을 수락합니다.
모든 명령은 또한 기계 읽기 가능한 출력을 위해 `--json`을 수락합니다 (안정적인 페이로드).

기본 사항:

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

동작:

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
- `openclaw browser download e12 report.pdf`
- `openclaw browser waitfordownload report.pdf`
- `openclaw browser upload /tmp/openclaw/uploads/file.pdf`
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
- `openclaw browser set headers --headers-json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

노트:

- `upload` 및 `dialog`는 **무장** 호출입니다; 선택기/대화상자를 트리거할 클릭/버튼 전에 실행하십시오.
- 다운로드 및 추적 출력 경로는 OpenClaw 임시 루트로 제한됩니다:
  - 추적: `/tmp/openclaw` (대체: `${os.tmpdir()}/openclaw`)
  - 다운로드: `/tmp/openclaw/downloads` (대체: `${os.tmpdir()}/openclaw/downloads`)
- 업로드 경로는 OpenClaw 임시 업로드 루트로 제한됩니다:
  - 업로드: `/tmp/openclaw/uploads` (대체: `${os.tmpdir()}/openclaw/uploads`)
- `upload`는 `--input-ref` 또는 `--element`를 통해 파일 입력을 직접 설정할 수도 있습니다.
- `snapshot`:
  - `--format ai` (Playwright가 설치되었을 때 기본값): 숫자 참조를 포함한 AI 스냅샷을 반환합니다 (`aria-ref="<n>"`).
  - `--format aria`: 접근성 트리 (참조 없음; 검사 전용)를 반환합니다.
  - `--efficient` (또는 `--mode efficient`): compact role snapshot preset (interactive + compact + depth + lower maxChars).
  - 설정 기본값 (도구/CLI 전용): `browser.snapshotDefaults.mode: "efficient"`을 설정하여 호출자가 모드를 전달하지 않을 때 효율적인 스냅샷을 사용할 수 있습니다 (참조 [Gateway 설정](/ko-KR/gateway/configuration#browser-openclaw-managed-browser)).
  - 역할 스냅샷 옵션 (`--interactive`, `--compact`, `--depth`, `--selector`)은 `ref=e12` 같은 참조를 가진 역할 기반 스냅샷을 강제 실행합니다.
  - `--frame "<iframe selector>"`는 역할 스냅샷을 iframe으로 범위 지정합니다 (역할 참조 `e12`와 함께 사용).
  - `--interactive`는 평평하고 **상호작용 가능한 요소의** 쉽게 선택할 수 있는 목록을 출력합니다 (동작에 가장 적합).
  - `--labels`는 참조 레이블과 함께 오버레이된 뷰포트 전용 스크린샷을 추가합니다 (출력 `MEDIA:<path>`).
- `click`/`type`/기타는 `snapshot`에서 참조가 필요합니다 (숫자 `12` 또는 역할 참조 `e12` 둘 중 하나).
  CSS 선택자는 의도적으로 동작에 대해 지원되지 않습니다.

## 스냅샷과 참조

OpenClaw는 두 가지 "스냅샷" 스타일을 지원합니다:

- **AI 스냅샷 (숫자 참조)**: `openclaw browser snapshot` (기본값; `--format ai`)
  - 출력: 숫자 참조가 포함된 텍스트 스냅샷.
  - 동작: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - 내부적으로, 참조는 Playwright의 `aria-ref`를 통해 해결됩니다.

- **역할 스냅샷 (역할 참조 `e12` 등)**: `openclaw browser snapshot --interactive` (또는 `--compact`, `--depth`, `--selector`, `--frame`)
  - 출력: `[ref=e12]` (그리고 선택적 `[nth=1]`)를 포함한 역할 기반 목록/트리.
  - 동작: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - 내부적으로, 참조는 `getByRole(...)` (중복의 경우 `nth()` 추가)로 해결됩니다.
  - `--labels`를 추가하여 오버레이된 `e12` 레이블이 포함된 뷰포트 스크린샷을 포함합니다.

참조 동작:

- 참조는 **탐색 간에 안정적이지 않습니다**; 무언가 실패하면 `snapshot`을 다시 실행하고 새 참조를 사용하세요.
- 역할 스냅샷이 `--frame`으로 실행된 경우, 역할 참조는 다음 역할 스냅샷까지 해당 iframe으로 범위가 지정됩니다.

## 대기 파워업

시간/텍스트 외에도 대기할 수 있습니다:

- URL 대기 (Playwright에서 지원하는 globs):
  - `openclaw browser wait --url "**/dash"`
- 로드 상태 대기:
  - `openclaw browser wait --load networkidle`
- JS 조건 대기:
  - `openclaw browser wait --fn "window.ready===true"`
- 선택자가 표시되기까지 대기:
  - `openclaw browser wait "#main"`

이것들은 조합될 수 있습니다:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## 디버그 워크플로우

동작이 실패할 때 (예: "보이지 않음", "엄격 모드 위반", "덮여 있음"):

1. `openclaw browser snapshot --interactive`
2. `click <ref>` / `type <ref>` 사용 (인터랙티브 모드에서 역할 참조를 선호)
3. 여전히 실패하면: `openclaw browser highlight <ref>`를 사용하여 Playwright가 어디를 타겟으로 하는지 확인
4. 페이지가 이상하게 작동하면:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. 깊은 디버깅을 위해: 추적 기록:
   - `openclaw browser trace start`
   - 문제를 재현
   - `openclaw browser trace stop` (출력 `TRACE:<path>`)

## JSON 출력

`--json`은 스크립팅 및 구조화된 도구 작성에 사용됩니다.

예시:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON에서의 역할 스냅샷은 `refs` 및 작은 `stats` 블록 (lines/chars/refs/interactive)을 포함하며, 도구가 페이로드 크기와 밀도를 판단할 수 있도록 합니다.

## 상태 및 환경 조절

이것들은 "사이트를 X처럼 동작하도록 만들기" 워크플로우에 유용합니다:

- 쿠키: `cookies`, `cookies set`, `cookies clear`
- 저장소: `storage local|session get|set|clear`
- 오프라인: `set offline on|off`
- 헤더: `set headers --headers-json '{"X-Debug":"1"}'` (레거시 `set headers --json '{"X-Debug":"1"}'`는 여전히 지원됨)
- HTTP 기본 인증: `set credentials user pass` (또는 `--clear`)
- 지리 위치 설정: `set geo <lat> <lon> --origin "https://example.com"` (또는 `--clear`)
- 미디어: `set media dark|light|no-preference|none`
- 시간대 / 로케일: `set timezone ...`, `set locale ...`
- 디바이스 / 뷰포트:
  - `set device "iPhone 14"` (Playwright 기기 프리셋)
  - `set viewport 1280 720`

## 보안 및 개인정보 보호

- openclaw 브라우저 프로파일은 로그인 세션을 포함할 수 있으므로 민감하게 취급해야 합니다.
- `browser act kind=evaluate` / `openclaw browser evaluate`와 `wait --fn`
  페이지 컨텍스트에서 임의의 JavaScript를 실행합니다. 프롬프트 인젝션이 이를 조작할 수 있습니다. 필요하지 않은 경우 `browser.evaluateEnabled=false`로 비활성화하십시오.
- 로그인 및 봇 방지 메모 (X/Twitter 등)에 대해서는 [브라우저 로그인 + X/Twitter 게시물](/ko-KR/tools/browser-login)을 참조하십시오.
- 게이트웨이/노드 호스트는 사설 (로컬 루프백 또는 tailnet 전용)로 유지하십시오.
- 원격 CDP 엔드포인트는 강력합니다; 터널링 및 보호하세요.

## 문제 해결

Linux 전용 문제 (특히 스냅 Chromium) 관련하여,
[브라우저 문제 해결](/ko-KR/tools/browser-linux-troubleshooting)을 참조하십시오.

## 에이전트 도구 및 제어 방법

에이전트는 브라우저 자동화에 대해 **하나의 도구**를 얻습니다:

- `browser` — 상태/시작/중지/탭/열기/집중/닫기/스냅샷/스크린샷/네비게이트/동작

매핑 방법:

- `browser snapshot`은 안정적인 UI 트리 (AI 또는 ARIA)를 반환합니다.
- `browser act`는 스냅샷 `ref` ID를 사용하여 클릭/입력/드래그/선택을 수행합니다.
- `browser screenshot`은 픽셀을 캡처합니다 (전체 페이지 또는 요소).
- `browser`는 다음을 수락합니다:
  - `profile`을 사용하여 이름 있는 브라우저 프로파일 (openclaw, chrome, 또는 원격 CDP)을 선택합니다.
  - `target` (`sandbox` | `host` | `node`)를 사용하여 브라우저가 있는 위치를 선택합니다.
  - 샌드박스 세션에서는 `target: "host"`가 `agents.defaults.sandbox.browser.allowHostControl=true`를 필요로 합니다.
  - `target`이 생략된 경우: 샌드박스 세션은 `sandbox`를 기본값으로, 비-샌드박스 세션은 `host`를 기본값으로 사용합니다.
  - 브라우저 지원 노드가 연결되면, 도구는 `target="host"` 또는 `target="node"`를 고정하지 않으면 자동으로 라우팅될 수 있습니다.

이는 에이전트를 결정론적으로 유지하며 취약한 선택기를 피합니다.
