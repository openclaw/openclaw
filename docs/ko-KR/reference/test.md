---
summary: "로컬에서 테스트를 실행하는 방법 (vitest) 및 force/coverage 모드를 사용하는 시기"
read_when:
  - 테스트 실행 또는 수정 시
title: "테스트"
---

# 테스트

- 전체 테스트 키트 (스위트, 실시간, Docker): [Testing](/ko-KR/help/testing)

- `pnpm test:force`: 기본 제어 포트를 점유하고 있는 게이트웨이의 모든 종료되지 않은 프로세스를 종료한 후, 격리된 게이트웨이 포트와 함께 전체 Vitest 스위트를 실행하여 서버 테스트가 실행 중인 인스턴스와 충돌하지 않도록 합니다. 이전 게이트웨이 실행이 포트 18789를 점유하고 남아 있을 때 사용합니다.
- `pnpm test:coverage`: V8 커버리지와 함께 유닛 스위트를 실행합니다 (`vitest.unit.config.ts` 이용). 전역 임계값은 70%의 라인/브랜치/함수/문장입니다. 커버리지는 통합이 많은 진입점을 제외하여 단위 테스트 가능한 로직에 초점을 맞춥니다 (CLI 배선, 게이트웨이/텔레그램 브리지, 웹챗 정적 서버).
- Node 24+에서 `pnpm test`: OpenClaw는 Vitest `vmForks`를 자동으로 비활성화하고 `ERR_VM_MODULE_LINK_FAILURE` / `모듈이 이미 연결됨`을 피하기 위해 `forks`를 사용합니다. `OPENCLAW_TEST_VM_FORKS=0|1`를 사용하여 동작을 강제로 설정할 수 있습니다.
- `pnpm test:e2e`: 게이트웨이 종단 간 스모크 테스트를 실행합니다 (다중 인스턴스 WS/HTTP/노드 페어링). `vitest.e2e.config.ts`에서 기본적으로 `vmForks`와 적응형 워커를 사용하며, `OPENCLAW_E2E_WORKERS=<n>`으로 조정하고, `OPENCLAW_E2E_VERBOSE=1`로 자세한 로그를 설정할 수 있습니다.
- `pnpm test:live`: 실시간 프로바이더 테스트를 실행합니다 (minimax/zai). API 키와 `LIVE=1` (또는 프로바이더별 `*_LIVE_TEST=1`)이 필요합니다.

## 모델 지연 시간 벤치마크 (로컬 키)

스크립트: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

사용 방법:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- 선택적 환경 변수: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- 기본 프롬프트: "단어 한 개로 답하시오: ok. 구두점이나 추가 텍스트 없음."

마지막 실행 (2025-12-31, 20 runs):

- minimax 중간값 1279ms (최소 1114, 최대 2431)
- opus 중간값 2454ms (최소 1224, 최대 3170)

## 온보딩 E2E (Docker)

Docker는 선택 사항이며, 컨테이너화된 온보딩 스모크 테스트에만 필요합니다.

클린 Linux 컨테이너에서의 전체 콜드 스타트 플로우:

```bash
scripts/e2e/onboard-docker.sh
```

이 스크립트는 인터랙티브 마법사를 가상 터미널을 통해 실행하며, 설정/작업 공간/세션 파일을 검증한 후 게이트웨이를 시작하고 `openclaw health`를 실행합니다.

## QR 가져오기 스모크 (Docker)

`qrcode-terminal`이 Docker의 Node 22+에서 로드됨을 보장합니다:

```bash
pnpm test:docker:qr
```