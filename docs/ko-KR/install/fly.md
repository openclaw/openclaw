---
title: Fly.io
description: Fly.io 에 OpenClaw 배포
---

# Fly.io 배포

**목표:** 지속적인 스토리지, 자동 HTTPS, Discord/채널 접근 권한을 가진 [Fly.io](https://fly.io) 머신에서 OpenClaw 게이트웨이를 운영합니다.

## 필요 항목

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) 설치
- Fly.io 계정 (무료 계층 사용 가능)
- 모델 인증: Anthropic API 키 (또는 다른 프로바이더 키)
- 채널 자격 증명: Discord 봇 토큰, Telegram 토큰 등

## 초보자를 위한 빠른 경로

1. 레포 클론 후 `fly.toml` 사용자 맞춤화
2. 앱 및 볼륨 생성 후 비밀 설정
3. `fly deploy`로 배포
4. SSH를 사용하여 설정 파일 생성 또는 컨트롤 UI 사용

## 1) Fly 앱 생성

```bash
# 레포 클론
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# 새 Fly 앱 생성 (사용자 이름 선택)
fly apps create my-openclaw

# 지속 볼륨 생성 (보통 1GB가 충분)
fly volumes create openclaw_data --size 1 --region iad
```

**팁:** 가까운 지역을 선택하세요. 일반적인 옵션: `lhr` (런던), `iad` (버지니아), `sjc` (산호세).

## 2) fly.toml 설정

앱 이름과 요구 사항에 맞춰 `fly.toml`을 편집하세요.

**보안 주의:** 기본 설정은 공개 URL을 노출합니다. 공개 IP 없이 강화된 배포를 위해 [Private Deployment](#private-deployment-hardened)를 참조하거나 `fly.private.toml`을 사용하세요.

```toml
app = "my-openclaw"  # Your app name
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  OPENCLAW_PREFER_PNPM = "1"
  OPENCLAW_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"

[mounts]
  source = "openclaw_data"
  destination = "/data"
```

**핵심 설정:**

| 설정                             | 이유                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `--bind lan`                   | Fly의 프록시가 게이트웨이에 도달할 수 있도록 `0.0.0.0`에 바인드                                  |
| `--allow-unconfigured`         | 구성 파일 없이 시작 (이후에 하나 생성할 예정)                                              |
| `internal_port = 3000`         | Fly 상태 점검을 위해 `--port 3000` (또는 `OPENCLAW_GATEWAY_PORT`)와 일치해야 함 |
| `memory = "2048mb"`            | 512MB는 너무 적음; 2GB 권장                                                        |
| `OPENCLAW_STATE_DIR = "/data"` | 볼륨에 상태를 저장                                                                   |

## 3) 비밀 설정

```bash
# 필수: 논-루프백 바인딩을 위한 게이트웨이 토큰
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# 모델 프로바이더 API 키
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# 선택 사항: 다른 프로바이더
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# 채널 토큰
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**참고 사항:**

- 논-루프백 바인딩 (`--bind lan`)은 보안을 위해 `OPENCLAW_GATEWAY_TOKEN`이 필요합니다.
- 이러한 토큰은 비밀번호와 같이 취급하세요.
- 모든 API 키와 토큰은 **설정 파일보다 환경 변수를 우선 순위**로 유지하세요. 이는 비밀이 `openclaw.json`에 실수로 노출되거나 기록되는 것을 방지합니다.

## 4) 배포

```bash
fly deploy
```

첫 배포는 Docker 이미지를 빌드하며 (~2-3분 소요) 이후 배포는 더 빠릅니다.

배포 후 확인:

```bash
fly status
fly logs
```

다음이 나타나야 합니다:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5) 설정 파일 생성

SSH로 머신에 접근하여 적절한 설정 파일을 만듭니다:

```bash
fly ssh console
```

설정 디렉터리와 파일 생성:

```bash
mkdir -p /data
cat > /data/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]
      },
      "maxConcurrent": 4
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  },
  "auth": {
    "profiles": {
      "anthropic:default": { "mode": "token", "provider": "anthropic" },
      "openai:default": { "mode": "token", "provider": "openai" }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "discord" }
    }
  ],
  "channels": {
    "discord": {
      "enabled": true,
      "groupPolicy": "allowlist",
      "guilds": {
        "YOUR_GUILD_ID": {
          "channels": { "general": { "allow": true } },
          "requireMention": false
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "auto"
  },
  "meta": {
    "lastTouchedVersion": "2026.1.29"
  }
}
EOF
```

**참고:** `OPENCLAW_STATE_DIR=/data`로 설정하면, 설정 경로는 `/data/openclaw.json`이 됩니다.

**참고:** Discord 토큰은 다음 경로 중 하나에서 제공될 수 있습니다:

- 환경 변수: `DISCORD_BOT_TOKEN` (비밀에 권장)
- 설정 파일: `channels.discord.token`

환경 변수를 사용하는 경우, 설정에 토큰을 추가할 필요가 없습니다. 게이트웨이는 `DISCORD_BOT_TOKEN`을 자동으로 읽습니다.

적용을 위해 재시작:

```bash
exit
fly machine restart <machine-id>
```

## 6) 게이트웨이 접근

### 컨트롤 UI

브라우저에서 열기:

```bash
fly open
```

또는 `https://my-openclaw.fly.dev/` 방문

게이트웨이 토큰 ( `OPENCLAW_GATEWAY_TOKEN`에서 나온)을 붙여넣어 인증합니다.

### 로그

```bash
fly logs              # 라이브 로그
fly logs --no-tail    # 최근 로그
```

### SSH 콘솔

```bash
fly ssh console
```

## 문제 해결

### "앱이 예상된 주소에서 듣고 있지 않음"

게이트웨이가 `127.0.0.1` 대신 `0.0.0.0`에 바인딩되고 있습니다.

**수정 방법:** `fly.toml`의 프로세스 명령어에 `--bind lan`을 추가하세요.

### 상태 검사 실패 / 연결 거부됨

Fly가 구성된 포트에서 게이트웨이에 도달할 수 없습니다.

**수정 방법:** `internal_port`가 게이트웨이 포트와 일치하는지 확인하세요 ( `--port 3000` 또는 `OPENCLAW_GATEWAY_PORT=3000` 설정).

### 메모리 문제 (OOM)

컨테이너가 계속 재시작되거나 종료됩니다. 징후: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, 또는 조용한 재시작.

**수정 방법:** `fly.toml`에서 메모리를 늘리세요:

```toml
[[vm]]
  memory = "2048mb"
```

또는 기존 머신 업데이트:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**참고:** 512MB는 너무 적습니다. 1GB는 작동할 수 있지만, 부하가 걸리거나 자세한 로그를 기록할 때 OOM이 발생할 수 있습니다. **2GB가 권장됩니다.**

### 게이트웨이 잠금 문제

게이트웨이가 "이미 실행 중" 오류로 시작을 거부합니다.

이는 컨테이너가 재시작되지만 PID 잠금 파일이 볼륨에 남아 있을 때 발생합니다.

**수정 방법:** 잠금 파일을 삭제하세요:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

잠금 파일은 `/data/gateway.*.lock`에 있습니다 (하위 디렉토리에 있지 않음).

### 구성 파일이 읽히지 않음

`--allow-unconfigured`를 사용하는 경우, 게이트웨이는 최소한의 설정을 생성합니다. `/data/openclaw.json`에 있는 사용자 정의 설정은 재시작 시 읽혀야 합니다.

구성 파일이 존재하는지 확인:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### SSH를 통한 설정 작성

`fly ssh console -C` 명령어는 셸 리디렉션을 지원하지 않습니다. 구성 파일을 작성하려면:

```bash
# echo + tee 사용 (로컬에서 원격으로 파이프)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# 또는 sftp 사용
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**참고:** `fly sftp`는 파일이 이미 존재할 경우 실패할 수 있습니다. 먼저 삭제하세요:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### 상태가 유지되지 않음

다시 시작 후 자격 증명이나 세션을 잃을 경우, 상태 디렉터리가 컨테이너 파일 시스템에 쓰이는 것입니다.

**수정 방법:** `OPENCLAW_STATE_DIR=/data`가 `fly.toml`에 설정되어 있는지 확인하고 다시 배포하세요.

## 업데이트

```bash
# 최신 변경 사항 가져오기
git pull

# 재배포
fly deploy

# 상태 확인
fly status
fly logs
```

### 머신 명령어 업데이트

전체 재배포 없이 시작 명령어를 변경해야 하는 경우:

```bash
# 머신 ID 가져오기
fly machines list

# 명령어 업데이트
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# 또는 메모리 증가와 함께
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**참고:** `fly deploy` 후에는 머신 명령어가 `fly.toml`에 있는 설정으로 재설정될 수 있습니다. 수동으로 변경한 경우, 배포 후 다시 적용하세요.

## 개인 배포 (강화된 설정)

기본적으로, Fly는 공개 IP를 할당하여 게이트웨이를 `https://your-app.fly.dev`에서 접근 가능하게 만듭니다. 이는 편리하지만 인터넷 스캐너 (Shodan, Censys 등)에 의해 배포가 탐지될 수 있음을 의미합니다.

**공개 노출 없이** 강화된 배포를 위해 개인 템플릿을 사용하세요.

### 개인 배포를 사용할 시기

- **문자/메시지**를 **인바운드 웹훅** 없이 **아웃바운드**로만 전송하는 경우
- **ngrok 또는 Tailscale** 터널을 웹훅 콜백에 사용하는 경우
- 브라우저 대신 **SSH, 프록시, 또는 WireGuard**로 게이트웨이에 액세스하는 경우
- 배포를 **인터넷 스캐너로부터 숨기려는 경우**

### 설정

표준 설정 대신 `fly.private.toml`을 사용하세요:

```bash
# 개인 설정으로 배포
fly deploy -c fly.private.toml
```

또는 기존 배포를 변환:

```bash
# 현재 IP 목록
fly ips list -a my-openclaw

# 공개 IP 제거
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# 미래 배포가 공개 IP를 재할당하지 않도록 개인 설정으로 전환
# ( [http_service] 제거하거나 개인 템플릿으로 배포)
fly deploy -c fly.private.toml

# 개인 전용 IPv6 할당
fly ips allocate-v6 --private -a my-openclaw
```

이후, `fly ips list`는 `private` 유형 IP만 표시해야 합니다:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### 개인 배포에 접근

공개 URL이 없으므로, 다음 방법 중 하나를 사용하세요:

**옵션 1: 로컬 프록시 (가장 간단함)**

```bash
# 앱으로 로컬 포트 3000 전달
fly proxy 3000:3000 -a my-openclaw

# 그런 다음 브라우저에서 http://localhost:3000 열기
```

**옵션 2: WireGuard VPN**

```bash
# WireGuard 설정 생성 (한 번만)
fly wireguard create

# WireGuard 클라이언트에 가져온 후 내부 IPv6로 액세스
# 예: http://[fdaa:x:x:x:x::x]:3000
```

**옵션 3: SSH만 사용**

```bash
fly ssh console -a my-openclaw
```

### 개인 배포로 웹훅

공개 노출 없이 웹훅 콜백 (Twilio, Telnyx 등) 필요 시:

1. **ngrok 터널** - 컨테이너 내부 또는 사이드카로 ngrok 실행
2. **Tailscale 터널** - Tailscale로 특정 경로 노출
3. **아웃바운드만** - 일부 프로바이더 (Twilio)는 웹훅 없이 아웃바운드 호출에 적합

ngrok을 사용한 음성 통화 설정 예시:

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio",
          "tunnel": { "provider": "ngrok" },
          "webhookSecurity": {
            "allowedHosts": ["example.ngrok.app"]
          }
        }
      }
    }
  }
}
```

ngrok 터널은 컨테이너 내에서 실행되며 Fly 앱 자체를 노출하지 않고 공개 웹훅 URL을 제공합니다. `webhookSecurity.allowedHosts`를 공개 터널 호스트 이름으로 설정하여 전달된 호스트 헤더가 허용되도록 합니다.

### 보안 이점

| 측면                  | 공개           | 개인         |
| ------------------ | ------------ | --------- |
| 인터넷 스캐너          | 탐지 가능         | 숨김         |
| 직접 공격             | 가능            | 차단         |
| 컨트롤 UI 접근        | 브라우저         | 프록시/VPN |
| 웹훅 전달            | 직접            | 터널을 통해  |

## 참고 사항

- Fly.io 는 **x86 아키텍처**를 사용합니다 (ARM 아님)
- Dockerfile은 두 아키텍처 모두 호환 가능합니다
- WhatsApp/Telegram 온보딩을 위한 `fly ssh console` 사용
- 지속 데이터는 `/data` 볼륨에 저장됩니다
- Signal은 Java + signal-cli를 필요로 합니다; 사용자 정의 이미지를 사용하고 메모리를 2GB 이상 유지하세요.

## 비용

권장 설정 (`shared-cpu-2x`, 2GB RAM)로:

- 사용량에 따라 약 $10-15/월
- 무료 계층에 일부 할당량 포함

자세한 내용은 [Fly.io 가격](https://fly.io/docs/about/pricing/)을 참조하세요.