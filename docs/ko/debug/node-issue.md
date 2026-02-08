---
read_when:
    - 노드 전용 개발 스크립트 또는 감시 모드 오류 디버깅
    - OpenClaw에서 tsx/esbuild 로더 충돌 조사
summary: Node + tsx "__name은 함수가 아닙니다." 충돌 메모 및 해결 방법
title: 노드 + tsx 충돌
x-i18n:
    generated_at: "2026-02-08T15:52:15Z"
    model: gtx
    provider: google-translate
    source_hash: f5beab7cdfe7679680f65176234a617293ce495886cfffb151518adfa61dc8dc
    source_path: debug/node-issue.md
    workflow: 15
---

# Node + tsx "\_\_name은 함수가 아닙니다" 충돌

## 요약

Node를 통해 OpenClaw 실행 `tsx` 다음과 같은 경우 시작 시 실패합니다.

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

이는 개발 스크립트를 Bun에서 다음으로 전환한 후에 시작되었습니다. `tsx` (저지르다 `2871657e`, 2026-01-06). Bun에서도 동일한 런타임 경로가 작동했습니다.

## 환경

- 노드: v25.x(v25.3.0에서 관찰됨)
- TSX: 4.21.0
- OS: macOS(Node 25를 실행하는 다른 플랫폼에서도 재현 가능)

## 재현(노드 전용)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## 저장소의 최소 재현

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## 노드 버전 확인

- 노드 25.3.0: 실패
- 노드 22.22.0(홈브루 `node@22`): 실패
- 노드 24: 여기에는 아직 설치되지 않았습니다. 확인이 필요합니다

## 메모/가설

- `tsx` esbuild를 사용하여 TS/ESM을 변환합니다. esbuild의 `keepNames` 방출 `__name` 도우미를 사용하고 함수 정의를 다음으로 래핑합니다. `__name(...)`.
- 충돌은 다음을 나타냅니다. `__name` 존재하지만 런타임 시 함수가 아닙니다. 이는 Node 25 로더 경로에서 이 모듈에 대한 도우미가 누락되었거나 덮어써졌음을 의미합니다.
- 비슷한 `__name` 도우미가 누락되거나 다시 작성된 경우 다른 esbuild 소비자에서 도우미 문제가 보고되었습니다.

## 회귀 기록

- `2871657e` (2026-01-06): Bun을 선택 사항으로 만들기 위해 스크립트가 Bun에서 tsx로 변경되었습니다.
- 그 전에(번 경로), `openclaw status` 그리고 `gateway:watch` 일했다.

## 해결 방법

- 개발 스크립트에는 Bun을 사용하십시오(현재 임시 되돌리기).
- Node + tsc watch를 사용한 다음 컴파일된 출력을 실행합니다.

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- 현지에서 확인됨: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` 노드 25에서 작동합니다.
- 가능하면 TS 로더에서 esbuild keepNames를 비활성화합니다(방지 `__name` 도우미 삽입); tsx는 현재 이를 노출하지 않습니다.
- 테스트 노드 LTS(22/24) `tsx` 문제가 노드 25에만 해당되는지 확인하세요.

## 참고자료

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## 다음 단계

- 노드 22/24에서 재현하여 노드 25 회귀를 확인합니다.
- 시험 `tsx` 알려진 회귀가 존재하는 경우 야간에 사용하거나 이전 버전으로 고정하세요.
- Node LTS에서 재현하는 경우 최소 재현 업스트림을 다음과 같이 제출하세요. `__name` 스택 추적.
