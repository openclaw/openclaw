---
summary: "Bun workflow (experimental): installs and gotchas vs pnpm"
read_when:
  - You want the fastest local dev loop (bun + watch)
  - You hit Bun install/patch/lifecycle script issues
title: "Bun (Experimental)"
x-i18n:
  source_hash: eb3f4c222b6bae49938d8bf53a0818fe5f5e0c0c3c1adb3e0a832ce8f785e1e3
---

# 롤빵 (실험적)

목표: **Bun**으로 이 저장소 실행(선택 사항, WhatsApp/Telegram에는 권장되지 않음)
pnpm 워크플로우에서 벗어나지 않고.

⚠️ **게이트웨이 런타임에는 권장되지 않습니다**(WhatsApp/Telegram 버그). 프로덕션에는 노드를 사용하세요.

## 상태

- Bun은 TypeScript를 직접 실행하기 위한 선택적 로컬 런타임입니다(`bun run …`, `bun --watch …`).
- `pnpm`는 빌드의 기본값이며 완전히 지원됩니다(일부 문서 도구에서 사용됨).
- Bun은 `pnpm-lock.yaml`를 사용할 수 없으며 무시합니다.

## 설치

기본값:

```sh
bun install
```

참고: `bun.lock`/`bun.lockb`는 무시되므로 어느 쪽이든 repo 변동이 없습니다. _잠금 파일 쓰기를 원하지 않는 경우_:

```sh
bun install --no-save
```

## 빌드/테스트(Bun)

```sh
bun run build
bun run vitest run
```

## Bun 수명 주기 스크립트(기본적으로 차단됨)

Bun은 명시적으로 신뢰하지 않는 한 종속성 수명 주기 스크립트를 차단할 수 있습니다(`bun pm untrusted` / `bun pm trust`).
이 저장소의 경우 일반적으로 차단되는 스크립트는 필요하지 않습니다.

- `@whiskeysockets/baileys` `preinstall`: Node major >= 20을 확인합니다(Node 22+를 실행합니다).
- `protobufjs` `postinstall`: 호환되지 않는 버전 체계에 대한 경고를 표시합니다(빌드 아티팩트 없음).

이러한 스크립트가 필요한 실제 런타임 문제가 발생한 경우 해당 스크립트를 명시적으로 신뢰하십시오.

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## 주의사항

- 일부 스크립트는 여전히 pnpm을 하드코딩합니다(예: `docs:build`, `ui:*`, `protocol:check`). 지금은 pnpm을 통해 실행하세요.
