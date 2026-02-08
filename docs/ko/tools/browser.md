---
read_when:
    - 에이전트 제어 브라우저 자동화 추가
    - openclaw가 자신의 Chrome을 방해하는 이유 디버깅
    - macOS 앱에서 브라우저 설정 + 수명 주기 구현
summary: 통합 브라우저 제어 서비스 + 액션 명령
title: 브라우저(OpenClaw 관리)
x-i18n:
    generated_at: "2026-02-08T16:12:26Z"
    model: gtx
    provider: google-translate
    source_hash: a868d040183436a1fb355130995e79782cb817b5ea298beaf1e1d2cb82e21c4c
    source_path: tools/browser.md
    workflow: 15
---

# 브라우저(openclaw 관리)

OpenClaw는 다음을 실행할 수 있습니다. **전용 Chrome/Brave/Edge/Chromium 프로필** 에이전트가 제어하는 ​​것입니다.
귀하의 개인 브라우저와 격리되어 소규모 로컬을 통해 관리됩니다.
게이트웨이 내부의 제어 서비스(루프백에만 해당)

초보자용 보기:

- 그것을 다음과 같이 생각하십시오. **별도의 에이전트 전용 브라우저**.
- 그만큼 `openclaw` 프로필은 **~ 아니다** 개인 브라우저 프로필을 터치하세요.
- 대리인은 다음을 수행할 수 있습니다. **탭 열기, 페이지 읽기, 클릭 및 입력** 안전한 차선에서.
- 기본값 `chrome` 프로필은 **시스템 기본 Chromium 브라우저** 를 통해
  확장 릴레이; 로 전환하다 `openclaw` 격리된 관리 브라우저의 경우.

## 당신이 얻는 것

- 이름이 지정된 별도의 브라우저 프로필 **발톱을 벌린** (기본적으로 주황색 악센트).
- 결정적 탭 제어(목록/열기/포커스/닫기).
- 상담원 작업(클릭/입력/드래그/선택), 스냅샷, 스크린샷, PDF.
- 선택적 다중 프로필 지원(`openclaw`, `work`, `remote`, ...).

이 브라우저는 **~ 아니다** 당신의 일일 드라이버. 안전하고 격리된 표면입니다.
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

- `openclaw`: 관리되고 격리된 브라우저(확장 프로그램이 필요하지 않음)
- `chrome`: 귀하의 확장 릴레이 **시스템 브라우저** (OpenClaw 필요
  탭에 첨부할 확장명).

세트 `browser.defaultProfile: "openclaw"` 기본적으로 관리 모드를 원하는 경우.

## 구성

브라우저 설정은 다음과 같습니다. `~/.openclaw/openclaw.json`.

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

- 브라우저 제어 서비스는 다음에서 파생된 포트의 루프백에 바인딩됩니다. `gateway.port`
  (기본: `18791`, 이는 게이트웨이 + 2)입니다. 릴레이는 다음 포트(`18792`).
- 게이트웨이 포트(`gateway.port` 또는 `OPENCLAW_GATEWAY_PORT`),
  파생된 브라우저 포트는 동일한 "패밀리"에 유지되도록 이동합니다.
- `cdpUrl` 설정되지 않은 경우 기본적으로 릴레이 포트가 사용됩니다.
- `remoteCdpTimeoutMs` 원격(비루프백) CDP 연결 가능성 검사에 적용됩니다.
- `remoteCdpHandshakeTimeoutMs` 원격 CDP WebSocket 연결 가능성 확인에 적용됩니다.
- `attachOnly: true` "로컬 브라우저를 시작하지 마십시오. 이미 실행 중인 경우에만 연결하십시오."를 의미합니다.
- `color` + 프로필별 `color` 어떤 프로필이 활성화되어 있는지 확인할 수 있도록 브라우저 UI에 색조를 적용합니다.
- 기본 프로필은 다음과 같습니다. `chrome` (확장 릴레이). 사용 `defaultProfile: "openclaw"` 관리되는 브라우저의 경우.
- 자동 감지 순서: Chromium 기반인 경우 시스템 기본 브라우저. 그렇지 않으면 Chrome → Brave → Edge → Chromium → Chrome Canary.
- 현지의 `openclaw` 프로필 자동 할당 `cdpPort`/`cdpUrl` — 원격 CDP에 대해서만 설정하십시오.

## Brave(또는 다른 Chromium 기반 브라우저)를 사용하세요.

만약 당신의 **시스템 기본값** 브라우저는 Chromium 기반(Chrome/Brave/Edge/etc)입니다.
OpenClaw는 이를 자동으로 사용합니다. 세트 `browser.executablePath` 재정의하다
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

- **로컬 제어(기본값):** 게이트웨이는 루프백 제어 서비스를 시작하고 로컬 브라우저를 시작할 수 있습니다.
- **원격 제어(노드 호스트):** 브라우저가 있는 시스템에서 노드 호스트를 실행합니다. 게이트웨이는 브라우저 작업을 프록시로 프록시합니다.
- **원격 CDP:** 세트 `browser.profiles.<name>.cdpUrl` (또는 `browser.cdpUrl`) 에
  원격 Chromium 기반 브라우저에 연결합니다. 이 경우 OpenClaw는 로컬 브라우저를 시작하지 않습니다.

원격 CDP URL에는 인증이 포함될 수 있습니다.

- 쿼리 토큰(예: `https://provider.example?token=<token>`)
- HTTP 기본 인증(예: `https://user:pass@provider.example`)

OpenClaw는 호출 시 인증을 유지합니다. `/json/*` 끝점 및 연결 시
CDP 웹소켓에. 환경 변수나 보안 비밀 관리자를 선호하세요.
구성 파일에 커밋하는 대신 토큰을 사용하세요.

## 노드 브라우저 프록시(제로 구성 기본값)

당신이 실행하는 경우 **노드 호스트** 브라우저가 있는 컴퓨터에서 OpenClaw는 다음을 수행할 수 있습니다.
추가 브라우저 구성 없이 해당 노드에 대한 브라우저 도구 호출을 자동 라우팅합니다.
이는 원격 게이트웨이의 기본 경로입니다.

참고:

- 노드 호스트는 다음을 통해 로컬 브라우저 제어 서버를 노출합니다. **프록시 명령**.
- 프로필은 노드 자체에서 가져옵니다. `browser.profiles` 구성(로컬과 동일)
- 원하지 않으면 비활성화하세요.
  - 노드에서: `nodeHost.browserProxy.enabled=false`
  - 게이트웨이에서: `gateway.nodes.browser.mode="off"`

## 브라우저리스(호스팅된 원격 CDP)

[브라우저리스](https://browserless.io) 노출하는 호스팅된 Chromium 서비스입니다.
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

- 바꾸다 `<BROWSERLESS_API_KEY>` 실제 브라우저리스 토큰으로.
- 브라우저리스 계정과 일치하는 지역 엔드포인트를 선택하세요(해당 문서 참조).

## 보안

주요 아이디어:

- 브라우저 제어는 루프백 전용입니다. 액세스는 게이트웨이의 인증 또는 노드 페어링을 통해 진행됩니다.
- 게이트웨이와 모든 노드 호스트를 개인 네트워크(Tailscale)에 유지합니다. 공개 노출을 피하십시오.
- 원격 CDP URL/토큰을 비밀로 취급합니다. 환경 변수 또는 비밀 관리자를 선호합니다.

원격 CDP 팁:

- 가능한 경우 HTTPS 엔드포인트와 단기 토큰을 선호하세요.
- 구성 파일에 수명이 긴 토큰을 직접 포함하지 마세요.

## 프로필(멀티 브라우저)

OpenClaw는 여러 명명된 프로필(라우팅 구성)을 지원합니다. 프로필은 다음과 같습니다.

- **오픈클로 관리**: 자체 사용자 데이터 디렉터리 + CDP 포트가 있는 전용 Chromium 기반 브라우저 인스턴스
- **원격**: 명시적인 CDP URL(다른 곳에서 실행되는 Chromium 기반 브라우저)
- **확장 릴레이**: 로컬 릴레이 + Chrome 확장 프로그램을 통한 기존 Chrome 탭

기본값:

- 그만큼 `openclaw` 프로필이 없으면 자동으로 생성됩니다.
- 그만큼 `chrome` 프로필은 Chrome 확장 릴레이에 내장되어 있습니다(다음을 가리킴). `http://127.0.0.1:18792` 기본적으로).
- 로컬 CDP 포트는 다음에서 할당됩니다. **18800~18899** 기본적으로.
- 프로필을 삭제하면 해당 로컬 데이터 디렉터리가 휴지통으로 이동됩니다.

모든 제어 엔드포인트가 허용합니다. `?profile=<name>`; CLI가 사용하는 `--browser-profile`.

## Chrome 확장 릴레이(기존 Chrome 사용)

OpenClaw도 운전할 수 있습니다 **기존 Chrome 탭** (별도의 "openclaw" Chrome 인스턴스 없음) 로컬 CDP 릴레이 + Chrome 확장 프로그램을 통해.

전체 가이드: [크롬 확장 프로그램](/tools/chrome-extension)

흐름:

- 게이트웨이는 로컬(동일한 시스템)에서 실행되거나 노드 호스트가 브라우저 시스템에서 실행됩니다.
- 현지인 **릴레이 서버** 루프백을 청취합니다. `cdpUrl`(기본: `http://127.0.0.1:18792`).
- 당신은 **OpenClaw 브라우저 릴레이** 첨부할 탭의 확장 아이콘(자동 첨부되지 않음)
- 에이전트는 일반 탭을 통해 해당 탭을 제어합니다. `browser` 도구를 사용하여 올바른 프로필을 선택합니다.

게이트웨이가 다른 곳에서 실행되는 경우 게이트웨이가 브라우저 작업을 프록시할 수 있도록 브라우저 시스템에서 노드 호스트를 실행합니다.

### 샌드박스 세션

에이전트 세션이 샌드박스 처리된 경우 `browser` 도구의 기본값은 다음과 같습니다. `target="sandbox"` (샌드박스 브라우저).
Chrome 확장 릴레이 인수에는 호스트 브라우저 제어가 필요하므로 다음 중 하나를 수행합니다.

- 샌드박스 처리되지 않은 세션을 실행하거나
-  세트 `agents.defaults.sandbox.browser.allowHostControl: true` 그리고 사용 `target="host"` 도구를 호출할 때.

### 설정

1. 확장 프로그램을 로드합니다(dev/unpacked):

```bash
openclaw browser extension install
```

- 크롬 → `chrome://extensions` → "개발자 모드" 활성화
- “Load unpacked” → 인쇄된 디렉토리 선택 `openclaw browser extension path`
- 확장 프로그램을 고정한 다음 제어하려는 탭에서 클릭하세요(배지가 표시됨). `ON`).

2. 사용하세요:

- CLI: `openclaw browser --browser-profile chrome tabs`
- 에이전트 도구: `browser` ~와 함께 `profile="chrome"`

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

- **전용 사용자 데이터 디렉토리**: 개인 브라우저 프로필을 절대 건드리지 마세요.
- **전용 포트**: 피하다 `9222` 개발 워크플로와의 충돌을 방지합니다.
- **결정적 탭 컨트롤**: 타겟 탭 기준 `targetId`, "마지막 탭"이 아닙니다.

## 브라우저 선택

로컬로 시작할 때 OpenClaw는 사용 가능한 첫 번째 항목을 선택합니다.

1. 크롬
2. 용감한
3. 가장자리
4. 크롬
5. 크롬 카나리아

다음으로 재정의할 수 있습니다. `browser.executablePath`.

플랫폼:

- macOS: 확인 `/Applications` 그리고 `~/Applications`.
- 리눅스: 찾는다 `google-chrome`, `brave`, `microsoft-edge`, `chromium`, 등.
- Windows: 일반적인 설치 위치를 확인합니다.

## 제어 API(선택사항)

로컬 통합의 경우에만 게이트웨이는 작은 루프백 HTTP API를 노출합니다.

- 상태/시작/중지: `GET /`, `POST /start`, `POST /stop`
- 탭: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- 스냅샷/스크린샷: `GET /snapshot`, `POST /screenshot`
- 행위: `POST /navigate`, `POST /act`
- 후크: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- 다운로드: `POST /download`, `POST /wait/download`
- 디버깅: `GET /console`, `POST /pdf`
- 디버깅: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- 회로망: `POST /response/body`
- 상태: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- 상태: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- 설정: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

모든 엔드포인트에서 허용 `?profile=<name>`.

### 극작가 요건

일부 기능(탐색/작업/AI 스냅샷/역할 스냅샷, 요소 스크린샷, PDF)에는
극작가. Playwright가 설치되지 않은 경우 해당 엔드포인트는 명확한 501을 반환합니다.
오류. ARIA 스냅샷과 기본 스크린샷은 openclaw 관리 Chrome에서 계속 작동합니다.
Chrome 확장 릴레이 드라이버의 경우 ARIA 스냅샷 및 스크린샷에는 Playwright가 필요합니다.

당신이 본다면 `Playwright is not available in this gateway build`, 전체 설치
극작가 패키지(아님 `playwright-core`) 게이트웨이를 다시 시작하거나 다시 설치하세요.
브라우저를 지원하는 OpenClaw.

#### Docker 극작가 설치

게이트웨이가 Docker에서 실행되는 경우 다음을 피하십시오. `npx playwright` (npm 재정의 충돌).
대신 번들 CLI를 사용하십시오.

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

브라우저 다운로드를 유지하려면 다음을 설정하십시오. `PLAYWRIGHT_BROWSERS_PATH` (예를 들어,
`/home/node/.cache/ms-playwright`) 그리고 확인하세요 `/home/node` 을 통해 지속됩니다
`OPENCLAW_HOME_VOLUME` 또는 바인드 마운트. 보다 [도커](/install/docker).

## 작동 방식(내부)

상위 수준 흐름:

- 작은 **제어 서버** HTTP 요청을 받아들입니다.
- Chromium 기반 브라우저(Chrome/Brave/Edge/Chromium)를 통해 연결됩니다. **CDP**.
- 고급 작업(클릭/입력/스냅샷/PDF)의 경우 다음을 사용합니다. **극작가** 위에
  CDP의.
- Playwright가 누락된 경우 Playwright 이외의 작업만 사용할 수 있습니다.

이 디자인은 에이전트를 안정적이고 결정적인 인터페이스에 유지하는 동시에
로컬/원격 브라우저와 프로필을 교환합니다.

## CLI 빠른 참조

모든 명령이 허용됩니다. `--browser-profile <name>` 특정 프로필을 타겟팅합니다.
모든 명령도 허용됩니다. `--json` 기계가 읽을 수 있는 출력(안정적인 페이로드)

기초:

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

점검:

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

행위: 

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

- `upload` 그리고 `dialog` ~이다 **무장** 전화; 클릭/누르기 전에 실행하세요.
  선택기/대화 상자를 트리거합니다.
- `upload` 다음을 통해 직접 파일 입력을 설정할 수도 있습니다. `--input-ref` 또는 `--element`.
- `snapshot`:
  - `--format ai` (Playwright가 설치된 경우 기본값): 숫자 참조가 포함된 AI 스냅샷을 반환합니다(`aria-ref="<n>"`).
  - `--format aria`: 접근성 트리를 반환합니다(참조 없음, 검사만 가능).
  - `--efficient` (또는 `--mode efficient`): 컴팩트 역할 스냅샷 사전 설정(대화형 + 컴팩트 + 깊이 + 낮은 maxChars).
  - 구성 기본값(도구/CLI만 해당): 설정 `browser.snapshotDefaults.mode: "efficient"` 호출자가 모드를 통과하지 못한 경우 효율적인 스냅샷을 사용하려면(참조 [게이트웨이 구성](/gateway/configuration#browser-openclaw-managed-browser)).
  - 역할 스냅샷 옵션(`--interactive`, `--compact`, `--depth`, `--selector`) 다음과 같은 참조를 사용하여 역할 기반 스냅샷을 강제합니다. `ref=e12`.
  - `--frame "<iframe selector>"` 역할 스냅샷의 범위를 iframe으로 지정합니다(다음과 같은 역할 참조와 쌍을 이룹니다). `e12`).
  - `--interactive` 단순하고 선택하기 쉬운 대화형 요소 목록을 출력합니다(액션을 유도하는 데 가장 적합).
  - `--labels` 오버레이된 참조 레이블이 있는 뷰포트 전용 스크린샷을 추가합니다(인쇄 `MEDIA:<path>`).
- `click`/`type`/etc에는 `ref` ~에서 `snapshot` (숫자 `12` 또는 역할 참조 `e12`).
  CSS 선택기는 작업에 대해 의도적으로 지원되지 않습니다.

## 스냅샷 및 참조

OpenClaw는 두 가지 "스냅샷" 스타일을 지원합니다.

- **AI 스냅샷(숫자 참조)**:`openclaw browser snapshot` (기본; `--format ai`)
  - 출력: 숫자 참조를 포함하는 텍스트 스냅샷.
  - 행위: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - 내부적으로 심판은 Playwright의 방법을 통해 해결됩니다. `aria-ref`.

- **역할 스냅샷(역할 참조: `e12`)**:`openclaw browser snapshot --interactive` (또는 `--compact`, `--depth`, `--selector`, `--frame`)
  - 출력: 역할 기반 목록/트리 `[ref=e12]` (그리고 선택사항 `[nth=1]`).
  - 행위: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - 내부적으로 심판은 다음을 통해 해결됩니다. `getByRole(...)` (을 더한 `nth()` 중복의 경우).
  - 추가하다 `--labels` 오버레이된 뷰포트 스크린샷을 포함하려면 `e12` 라벨.

참조 동작:

- 참조는 **탐색 전반에 걸쳐 안정적이지 않음**; 뭔가 실패하면 다시 실행하세요 `snapshot` 새로운 심판을 사용하십시오.
- 역할 스냅샷이 다음으로 생성된 경우 `--frame`, 역할 참조는 다음 역할 스냅샷까지 해당 iframe으로 범위가 지정됩니다.

## 파워업을 기다려라

시간/텍스트 이상의 것을 기다릴 수 있습니다.

- URL을 기다립니다(Playwright에서 지원하는 글로브):
  - `openclaw browser wait --url "**/dash"`
- 로드 상태를 기다립니다.
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

## 디버그 워크플로

작업이 실패하는 경우(예: '표시되지 않음', '엄격 모드 위반', '포함됨'):

1. `openclaw browser snapshot --interactive`
2. 사용 `click <ref>`/`type <ref>` (대화형 모드에서 역할 참조를 선호함)
3. 여전히 실패하는 경우: `openclaw browser highlight <ref>` 극작가가 무엇을 목표로 삼고 있는지 알아보기 위해
4. 페이지가 이상하게 동작하는 경우:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. 심층 디버깅의 경우: 추적을 기록합니다.
   - `openclaw browser trace start`
   - 문제를 재현하다
   - `openclaw browser trace stop` (인쇄물 `TRACE:<path>`)

## JSON 출력

`--json` 스크립팅 및 구조화된 도구를 위한 것입니다.

예:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON의 역할 스냅샷에는 다음이 포함됩니다. `refs` 게다가 작은 `stats` 도구가 페이로드 크기와 밀도를 추론할 수 있도록 블록(라인/문자/참조/대화형)입니다.

## 상태 및 환경 손잡이

이는 "사이트를 X처럼 동작하게 만들기" 작업 흐름에 유용합니다.

- 쿠키: `cookies`, `cookies set`, `cookies clear`
- 저장: `storage local|session get|set|clear`
- 오프라인: `set offline on|off`
- 헤더: `set headers --json '{"X-Debug":"1"}'` (또는 `--clear`)
- HTTP 기본 인증: `set credentials user pass` (또는 `--clear`)
- 지리적 위치: `set geo <lat> <lon> --origin "https://example.com"` (또는 `--clear`)
- 메디아: `set media dark|light|no-preference|none`
- 시간대/지역: `set timezone ...`, `set locale ...`
- 장치/뷰포트:
  - `set device "iPhone 14"` (극작가 장치 사전 설정)
  - `set viewport 1280 720`

## 보안 및 개인정보 보호

- openclaw 브라우저 프로필에는 로그인된 세션이 포함될 수 있습니다. 민감하게 다루세요.
- `browser act kind=evaluate`/`openclaw browser evaluate` 그리고 `wait --fn`
  페이지 컨텍스트에서 임의의 JavaScript를 실행합니다. 신속한 주입으로 방향을 잡을 수 있습니다
  이. 비활성화 `browser.evaluateEnabled=false` 필요하지 않은 경우.
- 로그인 및 안티봇 메모(X/Twitter 등)는 다음을 참조하세요. [브라우저 로그인 + X/Twitter 포스팅](/tools/browser-login).
- 게이트웨이/노드 호스트를 비공개로 유지합니다(루프백 또는 tailnet 전용).
- 원격 CDP 엔드포인트는 강력합니다. 터널을 만들어 보호하세요.

## 문제 해결

Linux 관련 문제(특히 Chromium 스냅)의 경우 다음을 참조하세요.
[브라우저 문제 해결](/tools/browser-linux-troubleshooting).

## 에이전트 도구 + 제어 작동 방식

에이전트가 가져옵니다. **하나의 도구** 브라우저 자동화의 경우:

- `browser` — 상태/시작/중지/탭/열기/초점/닫기/스냅샷/스크린샷/탐색/작동

매핑 방법:

- `browser snapshot` 안정적인 UI 트리(AI 또는 ARIA)를 반환합니다.
- `browser act` 스냅샷을 사용합니다 `ref` 클릭/입력/드래그/선택할 ID입니다.
- `browser screenshot` 픽셀(전체 페이지 또는 요소)을 캡처합니다.
- `browser` 다음을 수락합니다:
  - `profile` 명명된 브라우저 프로필(openclaw, chrome 또는 원격 CDP)을 선택합니다.
  - `target` (`sandbox` | `host` | `node`) 브라우저가 있는 위치를 선택합니다.
  - 샌드박스 세션에서는 `target: "host"` 필요하다 `agents.defaults.sandbox.browser.allowHostControl=true`.
  - 만약에 `target` 생략됨: 샌드박스 세션의 기본값은 다음과 같습니다. `sandbox`, 샌드박스가 아닌 세션의 기본값은 다음과 같습니다. `host`.
  - 브라우저 지원 노드가 연결된 경우 고정하지 않으면 도구가 해당 노드로 자동 라우팅될 수 있습니다. `target="host"` 또는 `target="node"`.

이는 에이전트의 결정성을 유지하고 불안정한 선택기를 방지합니다.
