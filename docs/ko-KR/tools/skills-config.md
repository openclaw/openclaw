---
summary: "스킬 설정 스키마 및 예제"
read_when:
  - 스킬 설정 추가 또는 수정
  - 번들 허용 목록이나 설치 동작 조정
title: "스킬 설정"
---

# 스킬 설정

모든 스킬 관련 설정은 `~/.openclaw/openclaw.json`의 `skills` 아래에 있습니다.

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
      nodeManager: "npm", // npm | pnpm | yarn | bun (게이트웨이 런타임은 여전히 Node; bun은 권장하지 않음)
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

- `allowBundled`: **번들**된 스킬에만 적용되는 선택적 허용 목록. 설정된 경우 목록에 있는 번들 스킬만 대상이 됩니다 (관리/작업 공간 스킬은 영향받지 않음).
- `load.extraDirs`: 추가로 스캔할 스킬 디렉토리 (최하위 우선순위).
- `load.watch`: 스킬 폴더를 감시하고 스킬 스냅샷을 갱신합니다 (기본값: true).
- `load.watchDebounceMs`: 스킬 감시 이벤트에 대한 밀리초 단위 디바운스 (기본값: 250).
- `install.preferBrew`: 사용 가능한 경우 brew 설치자를 우선 사용 (기본값: true).
- `install.nodeManager`: 노드 설치자 우선순위 (`npm` | `pnpm` | `yarn` | `bun`, 기본값: npm).
  이는 **스킬 설치**에만 영향을 미칩니다; 게이트웨이 런타임은 여전히 Node여야 합니다 (WhatsApp/Telegram에는 Bun 권장하지 않음).
- `entries.<skillKey>`: 스킬별 오버라이드.

스킬별 필드:

- `enabled`: 스킬이 번들되거나 설치되어 있어도 `false`로 설정하여 비활성화합니다.
- `env`: 에이전트 실행 시 주입되는 환경 변수 (이미 설정되어 있지 않은 경우에만).
- `apiKey`: 기본 환경 변수를 선언하는 스킬에 대한 선택적 편의 기능.

## 주의사항

- `entries` 아래의 키는 기본적으로 스킬 이름에 매핑됩니다. 스킬이 `metadata.openclaw.skillKey`를 정의하는 경우, 해당 키를 사용합니다.
- 스킬 변경 사항은 감시기가 활성화된 경우 다음 에이전트 턴에서 반영됩니다.

### 샌드박스 격리 스킬 + 환경 변수

세션이 **샌드박스 격리**될 때, 스킬 프로세스는 Docker 안에서 실행됩니다. 샌드박스는 호스트 `process.env`를 **상속하지 않습니다**.

다음 중 하나를 사용하십시오:

- `agents.defaults.sandbox.docker.env` (혹은 에이전트별 `agents.list[].sandbox.docker.env`)
- 사용자 지정 샌드박스 이미지를 사용하여 환경 변수를 프로비저닝

글로벌 `env`와 `skills.entries.<skill>.env/apiKey`는 **호스트** 실행에만 적용됩니다.
