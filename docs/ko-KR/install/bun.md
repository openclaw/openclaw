---
title: "Bun (실험적)"
summary: "Bun 워크플로우 (실험적): 설치 및 pnpm 과의 차이점"
read_when:
  - 가장 빠른 로컬 개발 루프 (bun + watch) 를 원할 때
  - Bun 설치/패치/라이프사이클 스크립트 문제가 있을 때
x-i18n:
  source_path: docs/install/bun.md
---

# Bun (실험적)

<Warning>
Bun 은 **Gateway 런타임으로 권장되지 않습니다** (WhatsApp 및 Telegram 에서 알려진 문제). 프로덕션에는 Node 를 사용하세요.
</Warning>

Bun 은 TypeScript 를 직접 실행 (`bun run ...`, `bun --watch ...`) 하기 위한 선택적 로컬 런타임입니다. 기본 패키지 매니저는 `pnpm` 이며, 완전히 지원되고 문서 도구에서 사용됩니다. Bun 은 `pnpm-lock.yaml` 을 사용할 수 없으며 무시합니다.

## 설치

<Steps>
  <Step title="의존성 설치">
    ```sh
    bun install
    ```

    `bun.lock` / `bun.lockb` 는 gitignore 에 있으므로 저장소 변경이 없습니다. lockfile 쓰기를 완전히 건너뛰려면:

    ```sh
    bun install --no-save
    ```

  </Step>
  <Step title="빌드 및 테스트">
    ```sh
    bun run build
    bun run vitest run
    ```
  </Step>
</Steps>

## 라이프사이클 스크립트

Bun 은 명시적으로 신뢰하지 않는 한 의존성 라이프사이클 스크립트를 차단합니다. 이 저장소에서 일반적으로 차단되는 스크립트는 필수가 아닙니다:

- `@whiskeysockets/baileys` `preinstall` -- Node 메이저 >= 20 확인 (OpenClaw 는 기본적으로 Node 24 를 사용하며 현재 `22.16+` 인 Node 22 LTS 도 지원)
- `protobufjs` `postinstall` -- 호환되지 않는 버전 체계에 대한 경고 출력 (빌드 아티팩트 없음)

이러한 스크립트가 필요한 런타임 문제가 발생하면 명시적으로 신뢰하세요:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## 주의사항

일부 스크립트는 여전히 pnpm 을 하드코딩합니다 (예: `docs:build`, `ui:*`, `protocol:check`). 현재로서는 이러한 스크립트를 pnpm 을 통해 실행하세요.
