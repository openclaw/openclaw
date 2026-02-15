---
summary: "Skills config schema and examples"
read_when:
  - Adding or modifying skills config
  - Adjusting bundled allowlist or install behavior
title: "Skills Config"
x-i18n:
  source_hash: e265c93da7856887c11abd92b379349181549e1a02164184d61a8d1f6b2feed5
---

# 스킬 구성

모든 스킬 관련 구성은 `~/.openclaw/openclaw.json`의 `skills` 아래에 있습니다.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## 필드

- `allowBundled`: **번들** 스킬에 대해서만 선택적 허용 목록입니다. 설정 시에만
  목록에 있는 번들 기술은 적격합니다(관리/작업 영역 기술은 영향을 받지 않음).
- `load.extraDirs`: 스캔할 추가 스킬 디렉토리(최하위 우선순위).
- `load.watch`: 스킬 폴더를 관찰하고 스킬 스냅샷을 새로 고칩니다(기본값: true).
- `load.watchDebounceMs`: 스킬 감시자 이벤트에 대한 밀리초 단위 디바운스(기본값: 250).
- `install.preferBrew`: 사용 가능한 경우 Brew 설치 프로그램을 선호합니다(기본값: true).
- `install.nodeManager`: 노드 설치 프로그램 기본 설정(`npm` | `pnpm` | `yarn` | `bun`, 기본값: npm).
  이는 **스킬 설치**에만 영향을 미칩니다. 게이트웨이 런타임은 여전히 노드여야 합니다.
  (WhatsApp/Telegram에는 권장되지 않습니다.)
- `entries.<skillKey>`: 스킬별 재정의.

기술별 필드:

- `enabled`: `false`를 설정하면 스킬이 번들/설치되어 있어도 비활성화됩니다.
- `env`: 에이전트 실행을 위해 삽입된 환경 변수(아직 설정되지 않은 경우에만).
- `apiKey`: 기본 환경 변수를 선언하는 스킬에 대한 선택적 편의입니다.

## 메모

- `entries` 아래의 키는 기본적으로 스킬 이름에 매핑됩니다. 스킬이 정의된 경우
  `metadata.openclaw.skillKey`, 대신 해당 키를 사용하세요.
- 스킬 변경 사항은 감시자가 활성화된 다음 에이전트 턴에 적용됩니다.

### 샌드박스 기술 + 환경 변수

세션이 **샌드박스**되면 Docker 내에서 기술 프로세스가 실행됩니다. 샌드박스
호스트 `process.env`를 상속하지 **않습니다**.

다음 중 하나를 사용하십시오.

- `agents.defaults.sandbox.docker.env` (또는 에이전트별 `agents.list[].sandbox.docker.env`)
- 환경을 사용자 정의 샌드박스 이미지에 굽습니다.

전역 `env` 및 `skills.entries.<skill>.env/apiKey`는 **호스트** 실행에만 적용됩니다.
