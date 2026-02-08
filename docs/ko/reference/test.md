---
read_when:
    - 테스트 실행 또는 수정
summary: 로컬에서 테스트를 실행하는 방법(vitest) 및 강제/커버리지 모드를 사용하는 경우
title: 테스트
x-i18n:
    generated_at: "2026-02-08T16:03:54Z"
    model: gtx
    provider: google-translate
    source_hash: 814cc52aae0788eba035479750f9415e89f12f43da70ee6bd9d960075e35e801
    source_path: reference/test.md
    workflow: 15
---

# 테스트

- 전체 테스트 키트(스위트, 라이브, Docker): [테스트](/help/testing)

- `pnpm test:force`: 기본 제어 포트를 보유하고 있는 모든 느린 게이트웨이 프로세스를 종료한 다음 격리된 게이트웨이 포트를 사용하여 전체 Vitest 제품군을 실행하므로 서버 테스트가 실행 중인 인스턴스와 충돌하지 않습니다. 이전 게이트웨이 실행이 포트 18789를 점유한 경우 이를 사용하십시오.
- `pnpm test:coverage`: V8 적용 범위로 Vitest를 실행합니다. 전역 임계값은 70% 라인/분기/함수/문입니다. 적용 범위는 통합이 많은 진입점(CLI 배선, 게이트웨이/텔레그램 브리지, 웹챗 정적 서버)을 제외하여 대상이 단위 테스트 가능한 논리에 집중하도록 합니다.
- `pnpm test:e2e`: 게이트웨이 엔드투엔드 스모크 테스트(다중 인스턴스 WS/HTTP/노드 페어링)를 실행합니다.
- `pnpm test:live`: 공급자 라이브 테스트(minimax/zai)를 실행합니다. API 키가 필요하며 `LIVE=1` (또는 제공업체별 `*_LIVE_TEST=1`) 건너뛰기를 취소합니다.

## 모델 지연 시간 벤치(로컬 키)

스크립트: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

용법:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- 선택적 환경: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- 기본 프롬프트: "한 단어로 답장하세요. 구두점이나 추가 텍스트는 없습니다."

마지막 실행(2025-12-31, 20회 실행):

- 최소 최대 중앙값 1279ms(최소 1114, 최대 2431)
- opus 중앙값 2454ms(최소 1224, 최대 3170)

## E2E 온보딩(Docker)

Docker는 선택 사항입니다. 이는 컨테이너화된 온보딩 연기 테스트에만 필요합니다.

깨끗한 Linux 컨테이너의 전체 콜드 스타트 ​​흐름:

```bash
scripts/e2e/onboard-docker.sh
```

이 스크립트는 pseudo-tty를 통해 대화형 마법사를 구동하고 구성/작업 공간/세션 파일을 확인한 다음 게이트웨이를 시작하고 실행합니다. `openclaw health`.

## QR 가져오기 연기(Docker)

보장 `qrcode-terminal` Docker의 Node 22+에서 로드됩니다.

```bash
pnpm test:docker:qr
```
