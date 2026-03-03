# #5 Gateway 순수 조합 전환 — 구현 기록

> **구현일**: 2026-02-19
> **상태**: Phase 1-4 완료 (6개 init 모듈 추출, 737→565 LOC)
> **설계 문서**: [05-gateway-composition.md](./05-gateway-composition.md)

---

## 1. 구현 요약

`server.impl.ts`에서 6개의 독립적인 초기화 모듈을 추출하여 조합 루트로의 전환을 완료했다.

### 추출된 모듈

| 모듈                         | LOC | 책임                                                                   |
| ---------------------------- | --- | ---------------------------------------------------------------------- |
| `server-init-config.ts`      | 83  | 설정 파일 읽기, 레거시 마이그레이션, 유효성 검사, 플러그인 자동 활성화 |
| `server-init-diagnostics.ts` | 25  | 진단 하트비트, SIGUSR1 재시작 정책, 재시작 전 대기 체크                |
| `server-init-control-ui.ts`  | 61  | Control UI 에셋 경로 해석, 자동 빌드, 오버라이드 처리                  |
| `server-init-registry.ts`    | 51  | NodeRegistry, 구독 매니저, 노드 이벤트 헬퍼, 레인 동시성               |
| `server-init-events.ts`      | 139 | 에이전트 이벤트, 하트비트, 유지보수 타이머, 스킬 리프레시              |
| `server-init-cron.ts`        | 30  | 크론 서비스 빌드 + 시작                                                |

### server.impl.ts 변경

| 항목      | 원본 | Phase 1 후 | Phase 2-4 후 |
| --------- | ---- | ---------- | ------------ |
| LOC       | 737  | 632        | 565          |
| import 수 | ~80  | 57         | 48           |

## 2. 변경된 파일 목록

### 신규 생성

- `src/gateway/server-init-config.ts` — `initGatewayConfig(port)` → `Config`
- `src/gateway/server-init-diagnostics.ts` — `initDiagnostics(cfg)` → `{ diagnosticsEnabled }`
- `src/gateway/server-init-control-ui.ts` — `resolveControlUiState(opts)` → `ControlUiRootState | undefined`

### 수정

- `src/gateway/server.impl.ts` — 인라인 초기화 로직을 모듈 호출로 교체, 32개 import 제거

### Phase 2-4 신규 생성

- `src/gateway/server-init-registry.ts` — `initGatewayRegistry(cfg)` → NodeRegistry + 구독 + 헬퍼
- `src/gateway/server-init-events.ts` — `initGatewayEvents(opts)` → 에이전트/하트비트 이벤트 + 유지보수 + 스킬
- `src/gateway/server-init-cron.ts` — `initGatewayCron(opts)` → 크론 서비스 빌드 + 시작

## 3. 설계 문서와의 차이

| 설계 문서 계획                 | 실제 구현               | 이유                                                     |
| ------------------------------ | ----------------------- | -------------------------------------------------------- |
| 8개 init 모듈                  | 6개 init 모듈           | 나머지 2개(channels, init-types)는 ROI 낮아 보류         |
| `GatewayInitContext` 공유 타입 | 각 함수가 개별 파라미터 | 함수별 파라미터가 충분히 다름, 공유 타입 불필요          |
| server.impl.ts → ~100줄        | → 565줄                 | 나머지는 WS 핸들러 부착/close 핸들러 등 강결합 코드      |
| import 40개 이하               | 48개                    | 거의 달성 — 나머지는 attachGatewayWsHandlers 등에서 필요 |

### Phase 2-4 완료 ✅

- [x] `server-init-registry.ts` 분리 (51 LOC — NodeRegistry + 구독 + 헬퍼 + 레인 동시성)
- [x] `server-init-events.ts` 분리 (139 LOC — 에이전트 이벤트 + 하트비트 + 유지보수 타이머 + 스킬 리프레시)
- [x] `server-init-cron.ts` 분리 (30 LOC — 크론 빌드 + 시작)
- [x] `GatewayInitContext` 미도입 (각 함수가 개별 파라미터 방식이 더 적합)

## 4. 제거된 import 목록

server.impl.ts에서 제거된 import:

- `path` (node:path)
- `getActiveEmbeddedRunCount` (agents/pi-embedded-runner)
- `getTotalPendingReplies` (auto-reply/reply)
- `formatCliCommand` (cli/command-format)
- `migrateLegacyConfig`, `writeConfigFile` (config/config)
- `applyPluginAutoEnable` (config/plugin-auto-enable)
- `isDiagnosticsEnabled` (infra/diagnostic-events)
- `logAcceptedEnvOption` (infra/env)
- `ensureControlUiAssetsBuilt`, `resolveControlUiRootOverrideSync`, `resolveControlUiRootSync` (infra/control-ui-assets)
- `setGatewaySigusr1RestartPolicy`, `setPreRestartDeferralCheck` (infra/restart)
- `startDiagnosticHeartbeat` (logging/diagnostic)
- `getTotalQueueSize` (process/command-queue)
- `ControlUiRootState` type (control-ui)

## 5. 테스트 결과

| 테스트                        | 결과                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- |
| `pnpm build`                  | ✅ 성공                                                                 |
| `src/gateway/` 전체 (47 파일) | 46 pass, 1 pre-existing failure                                         |
| Pre-existing failure          | `session-utils.fs.test.ts` (3 tests, data redaction 관련 — 변경과 무관) |

## 6. 운영 영향

- **런타임 동작 변경**: 없음 (순수 리팩토링)
- **마이그레이션**: 불필요
- **설정 변경**: 없음
