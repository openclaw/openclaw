---
description: Deploy OpenClaw on Fly.io
title: Fly.io
x-i18n:
    generated_at: "2026-02-08T15:57:39Z"
    model: gtx
    provider: google-translate
    source_hash: 148f8e3579f185f1b4062af50e5a829cc900eefce3a7d3365b7479223817fe5c
    source_path: install/fly.md
    workflow: 15
---

# Fly.io 배포

**목표:** OpenClaw Gateway는 다음에서 실행됩니다. [Fly.io](https://fly.io) 영구 저장소, 자동 HTTPS, Discord/채널 액세스 기능을 갖춘 머신입니다.

## 필요한 것

- [플라이CTL CLI](https://fly.io/docs/hands-on/install-flyctl/) 설치됨
- Fly.io 계정(무료 등급 작동)
- 모델 인증: Anthropic API 키(또는 기타 공급자 키)
- 채널 자격 증명: Discord 봇 토큰, Telegram 토큰 등

## 초보자 빠른 경로

1. 저장소 복제 → 사용자 정의 `fly.toml`
2. 앱 + 볼륨 생성 → 비밀 설정
3. 다음을 사용하여 배포 `fly deploy`
4. 구성을 생성하거나 Control UI를 사용하려면 SSH를 사용하세요.

## 1) Fly 앱 만들기

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**팁:** 가까운 지역을 선택하세요. 일반적인 옵션: `lhr` (런던), `iad` (여자 이름), `sjc` (산호세).

## 2) fly.toml 구성

편집하다 `fly.toml` 앱 이름 및 요구 사항과 일치하도록 합니다.

**보안 참고사항:** 기본 구성은 공개 URL을 노출합니다. 공용 IP가 없는 강화된 배포의 경우 다음을 참조하세요. [비공개 배포](#private-deployment-hardened) 또는 사용 `fly.private.toml`.

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

**주요 설정:**

| Setting                        | Why                                                                         |
| ------------------------------ | --------------------------------------------------------------------------- |
| `--bind lan`                   | Binds to `0.0.0.0` so Fly's proxy can reach the gateway                     |
| `--allow-unconfigured`         | Starts without a config file (you'll create one after)                      |
| `internal_port = 3000`         | Must match `--port 3000` (or `OPENCLAW_GATEWAY_PORT`) for Fly health checks |
| `memory = "2048mb"`            | 512MB is too small; 2GB recommended                                         |
| `OPENCLAW_STATE_DIR = "/data"` | Persists state on the volume                                                |

## 3) 비밀을 설정하세요

```bash
# Required: Gateway token (for non-loopback binding)
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Model provider API keys
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Optional: Other providers
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# Channel tokens
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**참고:**

- 비루프백 바인드(`--bind lan`) 필요하다 `OPENCLAW_GATEWAY_TOKEN` 보안을 위해.
- 이러한 토큰을 비밀번호처럼 취급하십시오.
- **구성 파일보다 환경 변수를 선호합니다.** 모든 API 키 및 토큰에 대해. 이렇게 하면 비밀이 유지됩니다. `openclaw.json` 실수로 노출되거나 기록될 수 있는 경우.

## 4) 배포

```bash
fly deploy
```

먼저 배포하면 Docker 이미지가 빌드됩니다(~2~3분). 후속 배포가 더 빨라집니다.

배포 후 다음을 확인합니다.

```bash
fly status
fly logs
```

다음을 확인해야 합니다.

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5) 구성 파일 생성

적절한 구성을 생성하려면 머신에 SSH를 연결하세요.

```bash
fly ssh console
```

구성 디렉터리와 파일을 만듭니다.

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

**메모:** 와 함께 `OPENCLAW_STATE_DIR=/data`, 구성 경로는 다음과 같습니다. `/data/openclaw.json`.

**메모:** Discord 토큰은 다음 중 하나에서 얻을 수 있습니다.

- 환경 변수: `DISCORD_BOT_TOKEN` (비밀에 권장됨)
- 구성 파일: `channels.discord.token`

env var를 사용하는 경우 구성에 토큰을 추가할 필요가 없습니다. 게이트웨이가 읽습니다. `DISCORD_BOT_TOKEN` 자동으로.

적용하려면 다시 시작하세요.

```bash
exit
fly machine restart <machine-id>
```

## 6) 게이트웨이에 접속

### 컨트롤 UI

브라우저에서 열기:

```bash
fly open
```

아니면 방문하세요 `https://my-openclaw.fly.dev/`

게이트웨이 토큰(다음 중 하나)을 붙여넣으세요. `OPENCLAW_GATEWAY_TOKEN`) 인증합니다.

### 로그

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH 콘솔

```bash
fly ssh console
```

## 문제 해결

### "앱이 예상 주소를 듣고 있지 않습니다."

게이트웨이가 바인딩됩니다. `127.0.0.1` 대신에 `0.0.0.0`.

**고치다:** 추가하다 `--bind lan` 프로세스 명령에 `fly.toml`.

### 상태 확인 실패/연결 거부

Fly는 구성된 포트의 게이트웨이에 연결할 수 없습니다.

**고치다:** 보장하다 `internal_port` 게이트웨이 포트와 일치합니다(설정됨 `--port 3000` 또는 `OPENCLAW_GATEWAY_PORT=3000`).

### OOM / 메모리 문제

컨테이너가 계속 다시 시작되거나 종료됩니다. 손짓: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`또는 자동으로 다시 시작됩니다.

**고치다:** 메모리 늘리기 `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

또는 기존 머신을 업데이트합니다.

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**메모:** 512MB는 너무 작습니다. 1GB도 작동할 수 있지만 로드 중이거나 자세한 로깅을 사용하면 OOM이 가능합니다. **2GB를 권장합니다.**

### 게이트웨이 잠금 문제

게이트웨이는 "이미 실행 중" 오류로 인해 시작을 거부합니다.

이는 컨테이너가 다시 시작되지만 PID 잠금 파일이 볼륨에 유지되는 경우 발생합니다.

**고치다:** 잠금 파일을 삭제합니다.

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

잠금 파일은 다음 위치에 있습니다. `/data/gateway.*.lock` (하위 디렉토리가 아님)

### 구성을 읽을 수 없음

사용하는 경우 `--allow-unconfigured`, 게이트웨이는 최소 구성을 생성합니다. 귀하의 맞춤 구성은 다음과 같습니다. `/data/openclaw.json` 다시 시작할 때 읽어야 합니다.

구성이 있는지 확인합니다.

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### SSH를 통해 구성 작성

그만큼 `fly ssh console -C` 명령은 쉘 리디렉션을 지원하지 않습니다. 구성 파일을 작성하려면:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**메모:** `fly sftp` 파일이 이미 있으면 실패할 수 있습니다. 먼저 삭제:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### 상태가 지속되지 않음

다시 시작한 후 자격 증명이나 세션이 손실되면 상태 디렉터리가 컨테이너 파일 시스템에 기록됩니다.

**고치다:** 보장하다 `OPENCLAW_STATE_DIR=/data` 에 설정되어 있습니다 `fly.toml` 그리고 재배포.

## 업데이트

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### 기계 명령 업데이트

전체 재배포 없이 시작 명령을 변경해야 하는 경우:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**메모:** 후에 `fly deploy`, 기계 명령은 다음에 있는 내용으로 재설정될 수 있습니다. `fly.toml`. 수동으로 변경한 경우 배포 후 다시 적용하세요.

## 비공개 배포(강화)

기본적으로 Fly는 공용 IP를 할당하여 게이트웨이에 액세스할 수 있도록 합니다. `https://your-app.fly.dev`. 이는 편리하지만 인터넷 스캐너(Shodan, Censys 등)로 배포를 검색할 수 있음을 의미합니다.

강화된 배포의 경우 **공개 노출 없음**, 개인 템플릿을 사용하십시오.

### 비공개 배포를 사용하는 경우

- 당신은 단지 **배 밖으로** 통화/메시지(인바운드 웹훅 없음)
- 당신은 사용 **ngrok 또는 Tailscale** 모든 웹훅 콜백을 위한 터널
- 다음을 통해 게이트웨이에 액세스합니다. **SSH, 프록시 또는 WireGuard** 브라우저 대신
- 배포를 원합니다 **인터넷 스캐너에서 숨겨진**

### 설정

사용 `fly.private.toml` 표준 구성 대신:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

또는 기존 배포를 변환합니다.

```bash
# List current IPs
fly ips list -a my-openclaw

# Release public IPs
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# Switch to private config so future deploys don't re-allocate public IPs
# (remove [http_service] or deploy with the private template)
fly deploy -c fly.private.toml

# Allocate private-only IPv6
fly ips allocate-v6 --private -a my-openclaw
```

이 후, `fly ips list` 만 표시해야합니다 `private` IP 유형:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### 비공개 배포에 액세스

공개 URL이 없으므로 다음 방법 중 하나를 사용하세요.

**옵션 1: 로컬 프록시(가장 간단함)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**옵션 2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**옵션 3: SSH만**

```bash
fly ssh console -a my-openclaw
```

### 비공개 배포가 포함된 웹훅

공개 노출 없이 웹훅 콜백(Twilio, Telnyx 등)이 필요한 경우:

1. **응록 터널** - 컨테이너 내부에서 또는 사이드카로 ngrok를 실행합니다.
2. **꼬리비늘 깔때기** - Tailscale을 통해 특정 경로 노출
3. **아웃바운드 전용** - 일부 공급자(Twilio)는 웹후크 없이 아웃바운드 통화에 잘 작동합니다.

ngrok를 사용한 음성 통화 구성의 예:

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

ngrok 터널은 컨테이너 내부에서 실행되며 Fly 앱 자체를 노출하지 않고 공개 웹훅 URL을 제공합니다. 세트 `webhookSecurity.allowedHosts` 공용 터널 호스트 이름에 연결하여 전달된 호스트 헤더가 허용되도록 합니다.

### 보안상의 이점

| Aspect            | Public       | Private    |
| ----------------- | ------------ | ---------- |
| Internet scanners | Discoverable | Hidden     |
| Direct attacks    | Possible     | Blocked    |
| Control UI access | Browser      | Proxy/VPN  |
| Webhook delivery  | Direct       | Via tunnel |

## 메모

- Fly.io는 다음을 사용합니다. **x86 아키텍처** (ARM 아님)
- Dockerfile은 두 아키텍처 모두와 호환됩니다.
- WhatsApp/Telegram 온보딩의 경우 다음을 사용하세요. `fly ssh console`
- 영구 데이터는 다음 볼륨에 있습니다. `/data`
- 신호에는 Java + signal-cli가 필요합니다. 사용자 정의 이미지를 사용하고 메모리를 2GB 이상으로 유지하세요.

## 비용

권장 구성(`shared-cpu-2x`, 2GB RAM):

- 사용량에 따라 ~$10-15/월
- 무료 등급에는 일부 허용량이 포함됩니다.

보다 [Fly.io 가격](https://fly.io/docs/about/pricing/) 자세한 내용은.
