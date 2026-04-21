# Reading Guide B — 부팅 플로우: CLI 명령부터 구동 중인 gateway까지

지도지 walkthrough가 아니다. 각 파일은 아래 질문에 답할 만큼만 열어보고 넘어가라. 한 번에 다 이해하려 하지 말 것.

## Stop 1 — bin 진입점

- `openclaw.mjs`
- 역할: Node 런타임 가드 + TypeScript CLI main으로 dispatch.
- 여기서 확인할 질문:
  - 이 파일이 실제 일을 하는가, 아니면 `src/cli/run-main.ts`로 가는 얇은 shim인가?
  - Node 버전 / 경로 warm-up은 실제 어디서 일어나나?
  - dispatch 전에 어떤 env var를 보나?

## Stop 2 — CLI dispatch + 두 개의 명령 서피스

- `src/cli/run-main.ts` — bin이 호출하는 메인 진입점.
- `src/cli/command-catalog.ts` — 라우팅되는 command id 목록. 명령 집합의 모양을 여기서 시작해 파악.
- `src/cli/command-bootstrap.ts` — 명령이 등록되고 연결되는 방식.
- `src/cli/gateway-cli/run.ts` — `gateway run` 명령 진입점 (daemon 스타일 부팅).
- `src/cli/progress.ts` — 부팅 전반에서 호출되는 공용 CLI 진행 표시 UI.
- 전용 `onboard` 명령은 없다. CLI 측에서 가장 근접한 서피스는 `src/cli/update-cli/wizard.ts`의 update/wizard 플로우. 진짜 onboarding 로직은 gateway 쪽에 있다(Stop 3 참조).
- 여기서 확인할 질문:
  - 원시 argv가 어떻게 명령 호출로 변환되나?
  - "gateway를 띄워라" 명령은 무엇인가?
  - 느린 부팅 스텝에 progress 렌더링이 어떻게 걸리나?

## Stop 3 — Onboarding 서피스

- `docs/start/wizard.md` — 사용자에게 보이는 onboarding 이야기.
- `docs/start/onboarding-overview.md` — 상위 narrative.
- `src/gateway/server-methods/wizard.ts` — gateway 측 wizard RPC 핸들러.
- `src/gateway/protocol/schema/wizard.ts` — wizard 스텝의 wire 스키마.
- Plugin SDK seam: `src/plugin-sdk/setup.ts`, `src/plugin-sdk/channel-setup.ts`, `src/plugin-sdk/provider-setup.ts`, `src/plugin-sdk/optional-channel-setup.ts`, `src/plugin-sdk/setup-tools.ts`, `src/plugin-sdk/self-hosted-provider-setup.ts`.
- 여기서 확인할 질문:
  - 어떤 setup 책임이 core 소유이고 어떤 게 plugin 소유인가?
  - plugin이 "이런 질문을 물어봐달라"고 어떻게 선언하나?
  - wizard RPC가 만족시키는 계약은 뭔가?

## Stop 4 — Gateway 부팅 + daemon 설치 + health

- `src/gateway/boot.ts` — gateway 프로세스 bootstrap.
- `src/gateway/client-bootstrap.ts` — 컴패니언 클라이언트/세션 bootstrap.
- `src/gateway/server-plugin-bootstrap.ts` — 서버 기동 중의 plugin 와이어링.
- `src/cli/daemon-cli/install.ts` + `install.runtime.ts` — launchd/systemd 설치 경로 (CLI 아래에 있음, `src/gateway/`가 아님).
- `src/cli/daemon-cli/lifecycle.ts`, `src/cli/daemon-cli/status.ts`, `src/cli/daemon-cli/restart-health.ts` — daemon 수명주기 + health probe.
- `src/gateway/channel-health-monitor.ts`, `src/gateway/channel-health-policy.ts`, `src/gateway/server.health.test.ts` — 채널 런타임 health.
- 여기서 확인할 질문:
  - 부팅 시 한 번만 하는 일과 매 reload마다 하는 일의 구분은?
  - "나를 시스템 서비스로 설치"가 macOS와 Linux에서 어디서 갈라지나?
  - 어떤 health 신호가 daemon을 살려두고, 어떤 게 강제 재시작을 유발하나?

## Stop 5 — 설정(Config) 계약

- `docs/gateway/configuration.md` — 말해진 계약.
- `docs/gateway/configuration-reference.md` — 생성 스타일 레퍼런스.
- `src/config/config.ts` — 루트 config 로더/shape (`src/config/` 아래에 `config-schema.ts`는 없음. schema 이름의 모듈은 `src/channels/plugins/config-schema.ts`, `src/plugins/config-schema.ts`, `src/plugin-sdk/config-schema.ts`에 존재).
- `src/config/types.openclaw.ts` — 루트 `OpenClawConfig` 타입.
- `src/config/defaults.ts` — 코드 측 기본값.
- 여기서 확인할 질문:
  - 기본값이 코드/문서/생성 메타데이터 중 어디에 살고, 충돌 시 어느 쪽이 이기나?
  - retired key 호환 경로는 어디에 있나?
  - validation은 부팅 순서 어디에서 일어나나?

## Stop 6 — 보안 기본값

- `docs/gateway/security.md` — 존재하지 않음. 가장 근접한 실제 문서는 `docs/gateway/authentication.md` + `docs/gateway/trusted-proxy-auth.md` + `docs/gateway/secrets.md`. 읽고 잡을 takeaway: 무엇이 돌기 전에 incoming request가 어떻게 인증되나?
- `docs/gateway/sandboxing.md` — 잡을 takeaway: 기본적으로 샌드박스 안에서 도는 건 뭐고, 무엇이 opt-in 해야 하나?

## 읽으면서 따로 모아둘 3개 질문

1. 코드(`src/config/defaults.ts`)에 사는 기본값과 문서(`docs/gateway/configuration-reference.md`)에 사는 기본값이 있을 때, 충돌하면 어느 쪽이 이기나?
2. 부팅 과정에서 gateway가 reachable해지는 시점은 plugin setup이 끝나기 **전**인가 **후**인가?
3. 서드파티 plugin이 오늘 onboarding 스텝에 영향을 줄 수 있는 지점은 어디까지이고, 여전히 core-only인 곳은 어딘가?
