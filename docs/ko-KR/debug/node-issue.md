```markdown
---
summary: Node + tsx "__name is not a function" 오류 노트 및 해결 방법
read_when:
  - Node 전용 개발 스크립트 또는 감시 모드 오류 디버깅
  - OpenClaw에서 tsx/esbuild 로더 충돌 조사
title: "Node + tsx 오류"
---

# Node + tsx "\_\_name is not a function" 오류

## 요약

`tsx`를 사용하여 Node로 OpenClaw를 실행하면 다음과 같은 오류가 발생합니다:
```

[openclaw] CLI 시작 실패: TypeError: \_\_name is not a function
at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
at .../src/agents/auth-profiles/constants.ts:25:20

````

이는 개발 스크립트를 Bun에서 `tsx`로 전환한 후 시작되었습니다 (커밋 `2871657e`, 2026-01-06). 동일한 런타임 경로는 Bun에서 작동했습니다.

## 환경

- Node: v25.x (v25.3.0에서 관찰됨)
- tsx: 4.21.0
- OS: macOS (Node 25를 실행할 수 있는 다른 플랫폼에서도 재현 가능할 것으로 예상됨)

## 재현 방법 (Node 전용)

```bash
# 저장소 루트에서
node --version
pnpm install
node --import tsx src/entry.ts status
````

## 최소 재현 방법

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node 버전 확인

- Node 25.3.0: 실패
- Node 22.22.0 (Homebrew `node@22`): 실패
- Node 24: 아직 설치되지 않음; 확인 필요

## 참고사항 / 가설

- `tsx`는 esbuild를 사용하여 TS/ESM을 변환합니다. esbuild의 `keepNames`는 `__name` 헬퍼를 생성하고 함수 정의를 `__name(...)`으로 포장합니다.
- 오류는 `__name`이 존재하지만 런타임에서 함수가 아님을 나타내며, 이는 해당 모듈의 Node 25 로더 경로에서 헬퍼가 누락되거나 덮어쓰여진 것임을 의미합니다.
- 다른 esbuild 소비자에서도 헬퍼가 누락되거나 재기록될 때 유사한 `__name` 헬퍼 문제가 보고되었습니다.

## 회귀 히스토리

- `2871657e` (2026-01-06): 스크립트가 Bun에서 tsx로 변경되면서 Bun이 선택적으로 됨.
- 그 전 (Bun 경로)에는 `openclaw status`와 `gateway:watch`가 작동함.

## 해결 방법

- 개발 스크립트에 Bun 사용 (현재 일시적 되돌림).
- Node + tsc 감시 사용, 그런 다음 컴파일된 출력 실행:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- 로컬에서 확인됨: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status`가 Node 25에서 작동함.
- 가능한 경우 TS 로더에서 esbuild keepNames 비활성화 (이를 통해 `__name` 헬퍼 삽입 방지); 현재 tsx에서는 이를 노출하지 않음.
- Node LTS (22/24)에서 `tsx`를 테스트하여 문제가 Node 25–특정 문제인지 확인.

## 참고 문서

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## 다음 단계

- Node 22/24에서 재현하여 Node 25의 회귀인지 확인.
- `tsx` 나이틀리 버전 테스트 또는 알려진 회귀가 있을 경우 이전 버전으로 고정.
- Node LTS에서 재현된다면 최소 재현을 통해 `__name` 스택 트레이스와 함께 상위에 보고.

```

```
