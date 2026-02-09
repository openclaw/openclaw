---
summary: "Bun 워크플로(실험적): pnpm 대비 설치 및 주의사항"
read_when:
  - 가장 빠른 로컬 개발 루프(bun + watch)를 원할 때
  - Bun 설치/패치/라이프사이클 스크립트 문제에 부딪혔을 때
title: "Bun (실험적)"
---

# Bun (실험적)

목표: pnpm 워크플로에서 벗어나지 않으면서 이 저장소를 **Bun** 으로 실행합니다(선택 사항, WhatsApp/Telegram 에는 권장하지 않음).

⚠️ **Gateway runtime 에는 권장하지 않습니다**(WhatsApp/Telegram 버그). 프로덕션에서는 Node 를 사용하십시오.

## 상태

- Bun 은 TypeScript 를 직접 실행하기 위한 선택적 로컬 런타임입니다(`bun run …`, `bun --watch …`).
- `pnpm` 는 빌드의 기본값이며 완전히 지원됩니다(일부 문서 도구에서도 사용됨).
- Bun 은 `pnpm-lock.yaml` 를 사용할 수 없으며 이를 무시합니다.

## 설치

기본값:

```sh
bun install
```

참고: `bun.lock`/`bun.lockb` 는 gitignored 되어 있으므로 어느 쪽이든 저장소 변경 사항은 없습니다. _락파일을 전혀 쓰지 않으려면_:

```sh
bun install --no-save
```

## 빌드 / 테스트 (Bun)

```sh
bun run build
bun run vitest run
```

## Bun 라이프사이클 스크립트(기본적으로 차단됨)

Bun 은 명시적으로 신뢰되지 않으면 의존성 라이프사이클 스크립트를 차단할 수 있습니다(`bun pm untrusted` / `bun pm trust`).
이 저장소의 경우, 일반적으로 차단되는 스크립트는 필요하지 않습니다:

- `@whiskeysockets/baileys` `preinstall`: Node 메이저 버전 >= 20 확인(우리는 Node 22+ 를 실행).
- `protobufjs` `postinstall`: 호환되지 않는 버전 스킴에 대한 경고 출력(빌드 산출물 없음).

이 스크립트가 필요한 실제 런타임 문제가 발생한다면, 명시적으로 신뢰 설정을 하십시오:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Caveats

- 일부 스크립트는 여전히 pnpm 을 하드코딩합니다(예: `docs:build`, `ui:*`, `protocol:check`). 현재로서는 해당 스크립트는 pnpm 으로 실행하십시오.
