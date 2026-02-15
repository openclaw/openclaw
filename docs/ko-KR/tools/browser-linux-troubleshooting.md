---
summary: "Fix Chrome/Brave/Edge/Chromium CDP startup issues for OpenClaw browser control on Linux"
read_when: "Browser control fails on Linux, especially with snap Chromium"
title: "Browser Troubleshooting"
x-i18n:
  source_hash: bac2301022511a0bf8ebe1309606cc03e8a979ff74866c894f89d280ca3e514e
---

# 브라우저 문제 해결(Linux)

## 문제: "포트 18800에서 Chrome CDP를 시작하지 못했습니다."

OpenClaw의 브라우저 제어 서버가 다음 오류로 인해 Chrome/Brave/Edge/Chromium을 시작하지 못합니다.

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### 근본 원인

Ubuntu(및 많은 Linux 배포판)에서 기본 Chromium 설치는 **스냅 패키지**입니다. Snap의 AppArmor 제한은 OpenClaw가 브라우저 프로세스를 생성하고 모니터링하는 방식을 방해합니다.

`apt install chromium` 명령은 스냅으로 리디렉션되는 스텁 패키지를 설치합니다.

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

이것은 실제 브라우저가 아닙니다. 단지 래퍼일 뿐입니다.

### 해결 방법 1: Google Chrome 설치(권장)

스냅으로 샌드박스 처리되지 않은 공식 Google Chrome `.deb` 패키지를 설치합니다.

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

그런 다음 OpenClaw 구성을 업데이트합니다(`~/.openclaw/openclaw.json`).

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### 해결 방법 2: 연결 전용 모드로 Snap Chromium 사용

스냅 Chromium을 사용해야 하는 경우 OpenClaw를 구성하여 수동으로 시작된 브라우저에 연결하세요.

1. 구성 업데이트:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. Chromium을 수동으로 시작합니다.

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. 선택적으로 Chrome을 자동 시작하는 시스템 사용자 서비스를 만듭니다.

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

다음으로 활성화: `systemctl --user enable --now openclaw-browser.service`

### 브라우저 작동 확인

상태 확인:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

테스트 브라우징:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### 구성 참조

| 옵션                     | 설명                                                             | 기본값                                             |
| ------------------------ | ---------------------------------------------------------------- | -------------------------------------------------- |
| `browser.enabled`        | 브라우저 제어 활성화                                             | `true`                                             |
| `browser.executablePath` | Chromium 기반 브라우저 바이너리 경로(Chrome/Brave/Edge/Chromium) | 자동 감지(Chromium 기반인 경우 기본 브라우저 선호) |
| `browser.headless`       | GUI 없이 실행                                                    | `false`                                            |
| `browser.noSandbox`      | `--no-sandbox` 플래그 추가(일부 Linux 설정에 필요)               | `false`                                            |
| `browser.attachOnly`     | 브라우저를 실행하지 말고 기존 브라우저에만 연결                  | `false`                                            |
| `browser.cdpPort`        | Chrome DevTools 프로토콜 포트                                    | `18800`                                            |

### 문제: "Chrome 확장 릴레이가 실행 중이지만 연결된 탭이 없습니다."

`chrome` 프로필(확장 릴레이)을 사용하고 있습니다. OpenClaw를 기대합니다.
라이브 탭에 첨부할 브라우저 확장입니다.

수정 옵션:

1. **관리형 브라우저를 사용하세요:** `openclaw browser start --browser-profile openclaw`
   (또는 `browser.defaultProfile: "openclaw"`를 설정).
2. **확장 릴레이 사용:** 확장을 설치하고 탭을 열고
   OpenClaw 확장 아이콘을 연결하세요.

참고:

- `chrome` 프로필은 가능한 경우 **시스템 기본 Chromium 브라우저**를 사용합니다.
- 로컬 `openclaw` 프로필 자동 할당 `cdpPort`/`cdpUrl`; 원격 CDP에 대해서만 설정하십시오.
