---
summary: "OpenClaw를 위한 고급 설정 및 개발 워크플로우"
read_when:
  - 새 머신 설정 중
  - 개인 설정을 깨지 않고 "latest + greatest"를 원할 때
title: "Setup"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/start/setup.md
  workflow: 15
---

# Setup

<Note>
처음으로 설정하는 경우 [Getting Started](/start/getting-started)로 시작합니다.
Wizard 세부 사항은 [Onboarding Wizard](/start/wizard)를 참조합니다.
</Note>

최종 업데이트: 2026-01-01

## TL;DR

- **Tailoring은 repo 외부에 살고 있습니다:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (config).
- **Stable workflow:** macOS app을 설치하고 bundled Gateway를 실행하도록 하세요.
- **Bleeding edge workflow:** `pnpm gateway:watch`를 통해 Gateway를 직접 실행한 다음 macOS app이 Local mode에서 attach하도록 하세요.

## Prereqs (from source)

- Node `>=22`
- `pnpm`
- Docker (optional; containerized setup/e2e용 only — [Docker](/install/docker) 참조)

## Tailoring strategy (업데이트가 손상되지 않도록)

"100% tailored to me" _and_ 쉬운 updates를 원하면 customization을 다음에 유지합니다:

- **Config:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memories; private git repo로 만듭니다)

한 번 bootstrap:

```bash
openclaw setup
```

이 repo 내에서 로컬 CLI entry를 사용합니다:

```bash
openclaw setup
```

아직 global install이 없으면 `pnpm openclaw setup`을 통해 실행합니다.

## repo에서 Gateway 실행

`pnpm build` 후 packaged CLI를 직접 실행할 수 있습니다:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Stable workflow (macOS app first)

1. **OpenClaw.app** (menu bar) 설치 + 실행.
2. onboarding/permissions checklist (TCC prompts) 완료.
3. Gateway가 **Local**이고 실행 중인지 확인 (the app이 관리).
4. Link surfaces (예: WhatsApp):

```bash
openclaw channels login
```

5. Sanity check:

```bash
openclaw health
```

onboarding이 build에서 사용 불가능한 경우:

- `openclaw setup`을 실행한 다음 `openclaw channels login`을 한 다음 manually Gateway를 시작합니다 (`openclaw gateway`).

## Bleeding edge workflow (terminal의 Gateway)

목표: TypeScript Gateway에서 작업하면서 hot reload를 받고 macOS app UI를 attached로 유지합니다.

### 0) (Optional) macOS app을 source에서도 실행

macOS app도 bleeding edge를 원하면:

```bash
./scripts/restart-mac.sh
```

### 1) dev Gateway 시작

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch`는 gateway를 watch mode에서 실행하고 TypeScript changes 시 reload합니다.

### 2) macOS app을 running Gateway로 가리킵니다

**OpenClaw.app**에서:

- Connection Mode: **Local**
  The app이 configured port에서 running gateway에 attach합니다.

### 3) Verify

- In-app Gateway status는 **"Using existing gateway …"**을 읽어야 합니다
- 또는 CLI를 통해:

```bash
openclaw health
```

### Common footguns

- **Wrong port:** Gateway WS는 기본값 `ws://127.0.0.1:18789`; app + CLI를 같은 port에 유지합니다.
- **Where state lives:**
  - Credentials: `~/.openclaw/credentials/`
  - Sessions: `~/.openclaw/agents/<agentId>/sessions/`
  - Logs: `/tmp/openclaw/`

## Credential storage map

auth 또는 backup 결정 시 사용합니다:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: config/env 또는 `channels.telegram.tokenFile`
- **Discord bot token**: config/env (token file yet 지원되지 않음)
- **Slack tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**:
  - `~/.openclaw/credentials/<channel>-allowFrom.json` (default account)
  - `~/.openclaw/credentials/<channel>-<accountId>-allowFrom.json` (non-default accounts)
- **Model auth profiles**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **File-backed secrets payload (optional)**: `~/.openclaw/secrets.json`
- **Legacy OAuth import**: `~/.openclaw/credentials/oauth.json`
  More detail: [Security](/gateway/security#credential-storage-map).

## Updating (setup 손상 없음)

- `~/.openclaw/workspace`와 `~/.openclaw/`을 "your stuff"로 유지; personal prompts/config을 `openclaw` repo에 넣지 마세요.
- Updating source: `git pull` + `pnpm install` (when lockfile changed) + keep using `pnpm gateway:watch`.

## Linux (systemd user service)

Linux installs는 systemd **user** service를 사용합니다. 기본적으로 systemd는 logout/idle에서 user services를 중지하므로 Gateway를 kills. Onboarding은 you를 위해 lingering을 활성화하려고 시도합니다 (sudo를 prompt할 수 있음). 아직 off이면 실행합니다:

```bash
sudo loginctl enable-linger $USER
```

Always-on 또는 multi-user servers의 경우 user service 대신 **system** service를 고려합니다 (lingering 불필요). [Gateway runbook](/gateway)의 systemd notes를 참조합니다.

## Related docs

- [Gateway runbook](/gateway) (flags, supervision, ports)
- [Gateway configuration](/gateway/configuration) (config schema + examples)
- [Discord](/channels/discord) and [Telegram](/channels/telegram) (reply tags + replyToMode settings)
- [OpenClaw assistant setup](/start/openclaw)
- [macOS app](/platforms/macos) (gateway lifecycle)
