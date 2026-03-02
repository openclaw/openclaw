---
summary: "통합 브라우저 제어 서비스 + 액션 커맨드"
read_when:
  - 에이전트가 제어하는 브라우저 자동화를 추가할 때
  - OpenClaw가 내 Chrome에 간섭하는 이유를 디버깅할 때
  - macOS 앱에서 브라우저 설정 및 라이프사이클을 구현할 때
title: "브라우저 (OpenClaw 관리)"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: tools/browser.md
workflow: 15
---

# 브라우저 (openclaw 관리)

OpenClaw는 **전용 Chrome/Brave/Edge/Chromium 프로필**을 실행할 수 있습니다. 에이전트가 이를 제어합니다.
개인 브라우저와는 격리되며 Gateway 내 작은 로컬
제어 서비스(loopback만)를 통해 관리됩니다.

초보자 관점:

- **별도의 에이전트 전용 브라우저**로 생각하세요.
- `openclaw` 프로필은 개인 브라우저 프로필에 **영향을 주지 않습니다**.
- 에이전트는 안전한 공간에서 **탭을 열고, 페이지를 읽고, 클릭하고, 텍스트를 입력**할 수 있습니다.
- 기본 `chrome` 프로필은 **시스템 기본 Chromium 브라우저**를 확장 리레이를 통해 사용합니다. 격리된 관리 브라우저의 경우 `openclaw`로 전환하세요.

## 제공되는 것

- **openclaw**라는 브라우저 프로필(기본적으로 주황색 강조).
- 결정론적 탭 제어(목록/열기/포커스/닫기).
- 에이전트 액션(클릭/입력/드래그/선택), 스냅샷, 스크린샷, PDF.
- 선택적 다중 프로필 지원(`openclaw`, `work`, `remote`, ...).

이 브라우저는 **일상적인 드라이버가 아닙니다**. 에이전트 자동화 및 검증을 위한 안전하고 격리된 표면입니다.

## 빠른 시작

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

"Browser disabled" 메시지가 나타나면 구성에서 활성화하고 (아래 참고)
Gateway를 다시 시작하세요.

## 프로필: `openclaw` vs `chrome`

- `openclaw`: 관리되고 격리된 브라우저(확장 필요 없음).
- `chrome`: **시스템 브라우저**에 대한 확장 리레이(OpenClaw
  확장이 탭에 연결되어야 함).

기본적으로 관리 모드를 원하면 `browser.defaultProfile: "openclaw"`을 설정하세요.

## 구성

브라우저 설정은 `~/.openclaw/openclaw.json`에 있습니다.

```json5
{
  browser: {
    enabled: true, // 기본값: true
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: true, // 기본값 신뢰 네트워크 모드
      // allowPrivateNetwork: true, // 레거시 별칭
      // hostnameAllowlist: ["*.example.com", "example.com"],
      // allowedHostnames: ["localhost"],
    },
    // cdpUrl: "http://127.0.0.1:18792", // 레거시 단일 프로필 오버라이드
    remoteCdpTimeoutMs: 1500, // 원격 CDP HTTP 타임아웃(ms)
    remoteCdpHandshakeTimeoutMs: 3000, // 원격 CDP WebSocket 핸드셰이크 타임아웃(ms)
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

- 브라우저 제어 서비스는 `gateway.port`에서 파생된 포트의 loopback에 바인딩됩니다
  (기본값: `18791`, 즉 gateway + 2). 리레이는 다음 포트를 사용합니다(`18792`).
- Gateway 포트를 오버라이드하면(`gateway.port` 또는 `OPENCLAW_GATEWAY_PORT`),
  파생된 브라우저 포트는 같은 "family"에 유지하도록 이동합니다.
- `cdpUrl`은 설정되지 않은 경우 리레이 포트로 기본값을 지정합니다.
- `remoteCdpTimeoutMs`는 원격(non-loopback) CDP 도달 가능성 확인에 적용됩니다.
- `remoteCdpHandshakeTimeoutMs`는 원격 CDP WebSocket 도달 가능성 확인에 적용됩니다.
- 브라우저 네비게이션/탭 열기는 내비게이션 전에 SSRF 보호되며 최종 `http(s)` URL 후 최선의 노력으로 재확인됩니다.
- `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`는 기본값 `true`(신뢰 네트워크 모델)입니다. 엄격한 공개 전용 브라우징의 경우 `false`로 설정하세요.
- `browser.ssrfPolicy.allowPrivateNetwork`는 호환성을 위해 레거시 별칭으로 계속 지원됩니다.
- `attachOnly: true`는 "절대 로컬 브라우저를 시작하지 않음; 이미 실행 중인 경우만 첨부"를 의미합니다.
- `color` + 프로필당 `color`는 브라우저 UI를 색칠하여 활성 프로필을 확인할 수 있게 합니다.
- 기본 프로필은 `chrome`(확장 리레이)입니다. 관리 브라우저의 경우 `defaultProfile: "openclaw"`를 사용하세요.
- 자동 감지 순서: Chromium 기반인 경우 시스템 기본 브라우저; 아니면 Chrome → Brave → Edge → Chromium → Chrome Canary.
- 로컬 `openclaw` 프로필은 `cdpPort`/`cdpUrl`을 자동으로 할당합니다 — 원격 CDP에만 설정하세요.

## Brave(또는 다른 Chromium 기반 브라우저) 사용

**시스템 기본** 브라우저가 Chromium 기반(Chrome/Brave/Edge/기타)인 경우,
OpenClaw는 자동으로 사용합니다. 자동 감지를 오버라이드하려면 `browser.executablePath`을 설정하세요:

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

## 로컬 vs 원격 제어

- **로컬 제어(기본값):** Gateway가 loopback 제어 서비스를 시작하고 로컬 브라우저를 시작할 수 있습니다.
- **원격 제어(노드 호스트):** 브라우저가 있는 머신에서 노드 호스트를 실행합니다; Gateway는 브라우저 액션을 프록시합니다.
- **원격 CDP:** `browser.profiles.<name>.cdpUrl`(또는 `browser.cdpUrl`)를 설정하여
  원격 Chromium 기반 브라우저에 연결합니다. 이 경우 OpenClaw는 로컬 브라우저를 시작하지 않습니다.

원격 CDP URL은 인증을 포함할 수 있습니다:

- 쿼리 토큰(예: `https://provider.example?token=<token>`)
- HTTP 기본 인증(예: `https://user:pass@provider.example`)

OpenClaw는 `/json/*` 엔드포인트 호출 및 CDP WebSocket 연결 시 인증을 유지합니다. 구성 파일에 커밋하는 대신 환경 변수 또는 비밀 관리자를 토큰으로 사용하는 것을 권장합니다.

## 노드 브라우저 프록시(제로 구성 기본값)

브라우저가 있는 머신에서 **노드 호스트**를 실행하는 경우, OpenClaw는 브라우저 도구 호출을 추가 브라우저 구성 없이 해당 노드에 자동으로 라우팅할 수 있습니다.
원격 Gateway의 경우 기본 경로입니다.

참고:

- 노드 호스트는 **프록시 커맨드**를 통해 로컬 브라우저 제어 서버를 노출합니다.
- 프로필은 노드의 자체 `browser.profiles` 구성에서 가져옵니다(로컬과 동일).
- 원하지 않으면 비활성화:
  - 노드에서: `nodeHost.browserProxy.enabled=false`
  - Gateway에서: `gateway.nodes.browser.mode="off"`

## Browserless(호스팅 원격 CDP)

[Browserless](https://browserless.io)는 HTTPS를 통해 CDP 엔드포인트를 노출하는 호스팅 Chromium 서비스입니다. OpenClaw 브라우저 프로필을
Browserless 지역 엔드포인트로 지정하고 API 키로 인증할 수 있습니다.

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

- `<BROWSERLESS_API_KEY>`를 실제 Browserless 토큰으로 바꾸세요.
- Browserless 계정과 일치하는 지역 엔드포인트를 선택하세요(해당 문서 참고).

## 보안

핵심 아이디어:

- 브라우저 제어는 loopback만; Gateway의 인증 또는 노드 pairing을 통해 액세스합니다.
- 브라우저 제어가 활성화되고 인증이 구성되지 않은 경우, OpenClaw는 시작 시 `gateway.auth.token`을 자동 생성하고 구성에 유지합니다.
- Gateway 및 모든 노드 호스트를 개인 네트워크(Tailscale)에 유지합니다. 공개 노출을 피하세요.
- 원격 CDP URL/토큰을 비밀로 처리합니다; 환경 변수 또는 비밀 관리자를 사용하는 것을 선호합니다.

원격 CDP 팁:

- 가능하면 HTTPS 엔드포인트 및 단기 토큰을 선호합니다.
- 구성 파일에 직접 장기 토큰을 포함시키지 마세요.

## 프로필(다중 브라우저)

OpenClaw는 여러 이름의 프로필(라우팅 구성)을 지원합니다. 프로필은 다음과 같을 수 있습니다:

- **openclaw 관리**: 자체 사용자 데이터 디렉터리 + CDP 포트가 있는 전용 Chromium 기반 브라우저 인스턴스
- **원격**: 명시적 CDP URL(다른 곳에서 실행 중인 Chromium 기반 브라우저)
- **확장 리레이**: 로컬 리레이 + Chrome 확장을 통한 기존 Chrome 탭

기본값:

- `openclaw` 프로필은 누락된 경우 자동 생성됩니다.
- `chrome` 프로필은 Chrome 확장 리레이용 기본 제공(기본적으로 `http://127.0.0.1:18792` 포함).
- 로컬 CDP 포트는 **18800–18899** 범위에서 할당됩니다.
- 프로필을 삭제하면 로컬 데이터 디렉터리가 휴지통으로 이동됩니다.

모든 제어 엔드포인트는 `?profile=<name>`을 수락합니다; CLI는 `--browser-profile`을 사용합니다.

## Chrome 확장 리레이(기존 Chrome 사용)

OpenClaw는 **기존 Chrome 탭**도 구동할 수 있습니다(별도의 "openclaw" Chrome 인스턴스 없음) 로컬 CDP 리레이 + Chrome 확장을 통해.

전체 가이드: [Chrome 확장](/tools/chrome-extension)

흐름:

- Gateway는 로컬(같은 머신)에서 또는 노드 호스트가 브라우저 머신에서 실행됩니다.
- 로컬 **리레이 서버**는 loopback `cdpUrl`(기본값: `http://127.0.0.1:18792`)에서 청취합니다.
- 탭에서 **OpenClaw 브라우저 리레이** 확장 아이콘을 클릭하여 첨부합니다(자동 첨부하지 않음).
- 에이전트는 정상 `browser` 도구를 통해 올바른 프로필을 선택하여 해당 탭을 제어합니다.

Gateway가 다른 곳에서 실행되는 경우, 브라우저 머신에서 노드 호스트를 실행하여 Gateway가 브라우저 액션을 프록시할 수 있게 하세요.

### 샌드박스된 세션

에이전트 세션이 샌드박스되어 있으면 `browser` 도구는 기본값 `target="sandbox"`(샌드박스 브라우저)일 수 있습니다.
Chrome 확장 리레이 인수는 호스트 브라우저 제어를 필요로 하므로:

- 세션을 샌드박스 해제하거나,
- `agents.defaults.sandbox.browser.allowHostControl: true`을 설정하고 도구를 호출할 때 `target="host"`를 사용합니다.

### 설정

1. 확장 로드(dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → "Developer mode" 활성화
- "Load unpacked" → `openclaw browser extension path`로 출력된 디렉터리 선택
- 확장을 고정하고 제어하려는 탭에서 클릭(배지가 `ON`을 표시).

2. 사용:

- CLI: `openclaw browser --browser-profile chrome tabs`
- 에이전트 도구: `browser`와 `profile="chrome"`

선택: 다른 이름이나 리레이 포트를 원하면 고유 프로필을 만드세요:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

참고:

- 이 모드는 대부분의 작업에 Playwright-on-CDP를 사용합니다(스크린샷/스냅샷/액션).
- 확장 아이콘을 다시 클릭하여 분리합니다.

## 격리 보장

- **전용 사용자 데이터 디렉터리**: 개인 브라우저 프로필을 건드리지 않습니다.
- **전용 포트**: `9222`를 피하여 개발 워크플로와의 충돌을 방지합니다.
- **결정론적 탭 제어**: "마지막 탭"이 아닌 `targetId`로 탭을 대상으로 합니다.

## 브라우저 선택

로컬로 시작할 때 OpenClaw는 처음 사용 가능한 것을 선택합니다:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

`browser.executablePath`로 오버라이드할 수 있습니다.

플랫폼:

- macOS: `/Applications` 및 `~/Applications` 확인.
- Linux: `google-chrome`, `brave`, `microsoft-edge`, `chromium` 등을 찾습니다.
- Windows: 일반적인 설치 위치를 확인합니다.

## 제어 API(선택 사항)

로컬 통합의 경우 Gateway는 작은 loopback HTTP API를 노출합니다:

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

모든 엔드포인트는 `?profile=<name>`을 수락합니다.

Gateway 인증이 구성된 경우 브라우저 HTTP 경로도 인증이 필요합니다:

- `Authorization: Bearer <gateway token>`
- `x-openclaw-password: <gateway password>` 또는 그 암호와 함께 HTTP Basic auth

### Playwright 요구 사항

일부 기능(navigate/act/AI snapshot/role snapshot, element screenshot, PDF)은 Playwright가 필요합니다. Playwright가 설치되지 않은 경우 해당 엔드포인트는 명확한 501
오류를 반환합니다. ARIA 스냅샷 및 기본 스크린샷은 openclaw 관리 Chrome에서 계속 작동합니다.
Chrome 확장 리레이 드라이버의 경우 ARIA 스냅샷 및 스크린샷에 Playwright가 필요합니다.

`Playwright is not available in this gateway build` 메시지가 보이면 전체
Playwright 패키지(playwright-core 아님)를 설치하고 Gateway를 다시 시작하거나, 브라우저 지원으로 OpenClaw를 다시 설치합니다.

#### Docker Playwright 설치

Gateway가 Docker에서 실행되는 경우 `npx playwright`(npm 오버라이드 충돌)를 피합니다.
대신 번들 CLI를 사용합니다:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

브라우저 다운로드를 유지하려면 `PLAYWRIGHT_BROWSERS_PATH`(예:
`/home/node/.cache/ms-playwright`)를 설정하고 `/home/node`가 `OPENCLAW_HOME_VOLUME` 또는 바인드 마운트를 통해 유지되도록 합니다. [Docker](/install/docker) 참고.

## 작동 방식(내부)

고급 흐름:

- 작은 **제어 서버**는 HTTP 요청을 수락합니다.
- **CDP**를 통해 Chromium 기반 브라우저(Chrome/Brave/Edge/Chromium)에 연결합니다.
- 고급 액션(클릭/입력/스냅샷/PDF)의 경우 **Playwright**를 CDP 위에서 사용합니다.
- Playwright가 누락된 경우 Playwright가 아닌 작업만 사용 가능합니다.

이 설계는 에이전트를 안정적이고 결정론적인 인터페이스에 유지하면서 로컬/원격 브라우저와 프로필을 교환할 수 있게 합니다.

## CLI 빠른 참조

모든 커맨드는 특정 프로필을 대상으로 `--browser-profile <name>`을 수락합니다.
모든 커맨드는 머신 판독 가능한 출력을 위해 `--json`도 수락합니다(안정적 페이로드).

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

참고:

- `upload`와 `dialog`는 **준비** 호출입니다; 선택자/대화상자를 트리거하는 클릭/누르기 전에 실행합니다.
- 다운로드 및 트레이스 출력 경로는 OpenClaw temp roots로 제한됩니다:
  - 트레이스: `/tmp/openclaw`(폴백: `${os.tmpdir()}/openclaw`)
  - 다운로드: `/tmp/openclaw/downloads`(폴백: `${os.tmpdir()}/openclaw/downloads`)
- 업로드 경로는 OpenClaw temp uploads root로 제한됩니다:
  - 업로드: `/tmp/openclaw/uploads`(폴백: `${os.tmpdir()}/openclaw/uploads`)
- `upload`는 `--input-ref` 또는 `--element`를 통해 파일 입력을 직접 설정할 수도 있습니다.
- `snapshot`:
  - `--format ai`(Playwright가 설치되었을 때 기본값): 숫자 참조가 있는 AI 스냅샷을 반환합니다(`aria-ref="<n>"`).
  - `--format aria`: 접근성 트리를 반환합니다(참조 없음; 검사만).
  - `--efficient`(또는 `--mode efficient`): 압축 역할 스냅샷 사전 설정(interactive + compact + depth + lower maxChars).
  - 구성 기본값(도구/CLI만): `browser.snapshotDefaults.mode: "efficient"`를 설정하여 호출자가 모드를 전달하지 않을 때 효율적인 스냅샷을 사용합니다([Gateway 구성](/gateway/configuration#browser-openclaw-managed-browser) 참고).
  - 역할 스냅샷 옵션(`--interactive`, `--compact`, `--depth`, `--selector`)은 `ref=e12`와 같은 참조가 있는 역할 기반 스냅샷을 강제합니다.
  - `--frame "<iframe selector>"`는 역할 스냅샷을 iframe로 범위를 지정합니다(역할 참조 `e12`와 쌍을 이룸).
  - `--interactive`는 대화형 요소의 평면, 선택하기 쉬운 목록을 출력합니다(액션을 드라이브하기 최고).
  - `--labels`는 오버레이된 참조 레이블이 있는 뷰포트 전용 스크린샷을 추가합니다(`MEDIA:<path>` 출력).
- `click`/`type` 등은 `snapshot`의 `ref`가 필요합니다(숫자 `12` 또는 역할 참조 `e12`).
  CSS 선택기는 의도적으로 액션에서 지원되지 않습니다.

## 스냅샷 및 참조

OpenClaw는 두 가지 "스냅샷" 스타일을 지원합니다:

- **AI 스냅샷(숫자 참조)**: `openclaw browser snapshot`(기본값; `--format ai`)
  - 출력: 숫자 참조가 있는 텍스트 스냅샷.
  - 액션: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - 내부적으로 참조는 Playwright의 `aria-ref`를 통해 해결됩니다.

- **역할 스냅샷(역할 참조 `e12`)**: `openclaw browser snapshot --interactive`(또는 `--compact`, `--depth`, `--selector`, `--frame`)
  - 출력: `[ref=e12]`(및 선택적 `[nth=1]`)이 있는 역할 기반 목록/트리.
  - 액션: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - 내부적으로 참조는 `getByRole(...)`(중복의 경우 `nth()` 포함)를 통해 해결됩니다.
  - `--labels`를 추가하여 오버레이된 `e12` 레이블이 있는 뷰포트 스크린샷을 포함합니다.

참조 동작:

- 참조는 **네비게이션 전 안정적이지 않습니다**; 실패하면 `snapshot`을 다시 실행하고 새로운 참조를 사용합니다.
- 역할 스냅샷을 `--frame`으로 사용한 경우, 역할 참조는 다음 역할 스냅샷까지 해당 iframe로 범위가 지정됩니다.

## 대기 강화

다만 시간/텍스트가 아니라 더 많은 것에서 기다릴 수 있습니다:

- URL 대기(Playwright에서 지원하는 glob):
  - `openclaw browser wait --url "**/dash"`
- 로드 상태 대기:
  - `openclaw browser wait --load networkidle`
- JS 술어 대기:
  - `openclaw browser wait --fn "window.ready===true"`
- 선택기가 표시될 때까지 대기:
  - `openclaw browser wait "#main"`

이들을 결합할 수 있습니다:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## 디버그 워크플로우

액션이 실패할 때(예: "not visible", "strict mode violation", "covered"):

1. `openclaw browser snapshot --interactive`
2. `click <ref>` / `type <ref>` 사용(interactive 모드에서는 역할 참조 선호)
3. 계속 실패하면: `openclaw browser highlight <ref>`로 Playwright가 대상으로 하는 것을 확인
4. 페이지가 이상하게 동작하면:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. 깊은 디버깅: 트레이스 기록:
   - `openclaw browser trace start`
   - 문제 재현
   - `openclaw browser trace stop`(`TRACE:<path>` 출력)

## JSON 출력

`--json`은 스크립팅 및 구조화된 도구용입니다.

예:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON의 역할 스냅샷에는 `refs` 및 작은 `stats` 블록(lines/chars/refs/interactive)이 포함되어 도구가 페이로드 크기 및 밀도에 대해 추론할 수 있습니다.

## 상태 및 환경 노브

이들은 "사이트가 X처럼 동작하게 만들기" 워크플로우에 유용합니다:

- 쿠키: `cookies`, `cookies set`, `cookies clear`
- 저장소: `storage local|session get|set|clear`
- 오프라인: `set offline on|off`
- 헤더: `set headers --headers-json '{"X-Debug":"1"}'`(레거시 `set headers --json '{"X-Debug":"1"}'`는 계속 지원됨)
- HTTP 기본 인증: `set credentials user pass`(또는 `--clear`)
- 지리 위치: `set geo <lat> <lon> --origin "https://example.com"`(또는 `--clear`)
- 미디어: `set media dark|light|no-preference|none`
- 타임존 / 로캘: `set timezone ...`, `set locale ...`
- 디바이스 / 뷰포트:
  - `set device "iPhone 14"`(Playwright 디바이스 사전 설정)
  - `set viewport 1280 720`

## 보안 및 개인 정보

- openclaw 브라우저 프로필에는 로그인한 세션이 있을 수 있습니다; 민감한 것으로 취급합니다.
- `browser act kind=evaluate` / `openclaw browser evaluate` 및 `wait --fn`
  은 페이지 컨텍스트에서 임의의 JavaScript를 실행합니다. 프롬프트 주입이 이를 조종할 수 있습니다. `browser.evaluateEnabled=false`로 비활성화하세요(필요하지 않은 경우).
- 로그인 및 anti-bot 참고(X/Twitter 등)는 [브라우저 로그인 + X/Twitter 게시](/tools/browser-login)를 참고합니다.
- Gateway/노드 호스트를 개인 상태(loopback 또는 tailnet만)로 유지합니다.
- 원격 CDP 엔드포인트는 강력합니다; 터널 및 보호합니다.

엄격 모드 예(기본적으로 개인/내부 대상 차단):

```json5
{
  browser: {
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: false,
      hostnameAllowlist: ["*.example.com", "example.com"],
      allowedHostnames: ["localhost"], // 선택사항 정확한 허용
    },
  },
}
```

## 문제 해결

Linux 특정 문제(특히 snap Chromium)는 [브라우저 문제 해결](/tools/browser-linux-troubleshooting)을 참고합니다.

## 에이전트 도구 + 제어 작동 방식

에이전트는 브라우저 자동화용 **하나의 도구**를 받습니다:

- `browser` — status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act

매핑 방법:

- `browser snapshot`은 안정적인 UI 트리(AI 또는 ARIA)를 반환합니다.
- `browser act`는 스냅샷 `ref` ID를 사용하여 클릭/입력/드래그/선택합니다.
- `browser screenshot`은 픽셀을 캡처합니다(전체 페이지 또는 요소).
- `browser`는 다음을 수락합니다:
  - 명명된 브라우저 프로필을 선택하기 위한 `profile`(openclaw, chrome, 또는 원격 CDP).
  - 브라우저가 어디에 있는지 선택하기 위한 `target`(`sandbox` | `host` | `node`).
  - 샌드박스된 세션에서 `target: "host"`는 `agents.defaults.sandbox.browser.allowHostControl=true`를 필요로 합니다.
  - `target`이 생략된 경우: 샌드박스된 세션은 기본값 `sandbox`, 비 샌드박스 세션은 기본값 `host`.
  - 브라우저 가능 노드가 연결된 경우, 도구는 `target="host"` 또는 `target="node"`를 고정하지 않는 한 자동으로 라우팅할 수 있습니다.

이는 에이전트를 결정론적으로 유지하고 취약한 선택기를 피합니다.
