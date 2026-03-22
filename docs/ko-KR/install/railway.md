---
title: "Railway"
summary: "원클릭 템플릿으로 Railway 에 OpenClaw 배포"
read_when:
  - Railway 에 OpenClaw 를 배포할 때
  - 브라우저 기반 설정으로 원클릭 클라우드 배포를 원할 때
x-i18n:
  source_path: docs/install/railway.mdx
---

원클릭 템플릿으로 Railway 에 OpenClaw 를 배포하고 브라우저에서 설정을 완료합니다.
이것은 가장 쉬운 "서버에 터미널 없이" 경로입니다: Railway 가 Gateway 를 실행하고,
`/setup` 웹 마법사를 통해 모든 것을 구성합니다.

## 빠른 체크리스트 (새 사용자)

1. 아래의 **Deploy on Railway** 를 클릭합니다.
2. `/data` 에 마운트된 **Volume** 을 추가합니다.
3. 필수 **Variables** 를 설정합니다 (최소 `SETUP_PASSWORD`).
4. 포트 `8080` 에서 **HTTP Proxy** 를 활성화합니다.
5. `https://<your-railway-domain>/setup` 을 열고 마법사를 완료합니다.

## 원클릭 배포

<a href="https://railway.com/deploy/clawdbot-railway-template" target="_blank" rel="noreferrer">
  Deploy on Railway
</a>

배포 후 **Railway > your service > Settings > Domains** 에서 공용 URL 을 찾습니다.

Railway 는 다음 중 하나를 제공합니다:

- 생성된 도메인 (보통 `https://<something>.up.railway.app`), 또는
- 첨부한 커스텀 도메인

그런 다음 열기:

- `https://<your-railway-domain>/setup` -- 웹 설정 (비밀번호 보호)
- `https://<your-railway-domain>/openclaw` -- Control UI

## 제공되는 것

- 호스팅된 OpenClaw Gateway + Control UI
- `/setup` 에서 웹 설정 (터미널 명령 불필요)
- Railway Volume (`/data`) 을 통한 영속 스토리지로 설정/자격 증명/작업 공간이 재배포 후에도 유지
- 나중에 Railway 에서 마이그레이션하기 위한 `/setup/export` 에서 백업 내보내기

## 필수 Railway 설정

### 퍼블릭 네트워킹

서비스에 대해 **HTTP Proxy** 를 활성화합니다.

- 포트: `8080`

### Volume (필수)

다음에 마운트된 볼륨을 첨부합니다:

- `/data`

### 변수

서비스에 다음 변수를 설정합니다:

- `SETUP_PASSWORD` (필수)
- `PORT=8080` (필수 -- Public Networking 의 포트와 일치해야 함)
- `OPENCLAW_STATE_DIR=/data/.openclaw` (권장)
- `OPENCLAW_WORKSPACE_DIR=/data/workspace` (권장)
- `OPENCLAW_GATEWAY_TOKEN` (권장; 관리자 시크릿으로 취급)

## 설정 플로우

1. `https://<your-railway-domain>/setup` 을 방문하고 `SETUP_PASSWORD` 를 입력합니다.
2. 모델/인증 프로바이더를 선택하고 키를 붙여넣습니다.
3. (선택 사항) Telegram/Discord/Slack 토큰을 추가합니다.
4. **Run setup** 을 클릭합니다.

Telegram DM 이 페어링으로 설정된 경우 웹 설정에서 페어링 코드를 승인할 수 있습니다.

## 채널 연결

Telegram 또는 Discord 토큰을 `/setup` 마법사에 붙여넣습니다. 설정
지침은 채널 문서를 참고하세요:

- [Telegram](/channels/telegram) (가장 빠름 -- 봇 토큰만 필요)
- [Discord](/channels/discord)
- [모든 채널](/channels)

## 백업 및 마이그레이션

다음에서 백업을 다운로드합니다:

- `https://<your-railway-domain>/setup/export`

설정이나 메모리를 잃지 않고 다른 호스트로 마이그레이션할 수 있도록 OpenClaw 상태 + 작업 공간을 내보냅니다.

## 다음 단계

- 메시징 채널 설정: [채널](/channels)
- Gateway 구성: [Gateway 구성](/gateway/configuration)
- OpenClaw 최신 상태 유지: [업데이트](/install/updating)
