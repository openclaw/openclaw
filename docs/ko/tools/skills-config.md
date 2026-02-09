---
summary: "Skills 설정 스키마 및 예제"
read_when:
  - Skills 설정을 추가하거나 수정할 때
  - 번들된 allowlist 또는 설치 동작을 조정할 때
title: "Skills 설정"
---

# Skills 설정

모든 skills 관련 구성은 `skills` 아래의 `~/.openclaw/openclaw.json`에 있습니다.

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

- `allowBundled`: **번들된** skills 전용의 선택적 allowlist입니다. 설정하면 목록에 있는
  번들된 skills 만 대상이 됩니다(관리/워크스페이스 skills 는 영향 없음).
- `load.extraDirs`: 스캔할 추가 skill 디렉토리(가장 낮은 우선순위).
- `load.watch`: skill 폴더를 감시하고 skills 스냅샷을 새로 고칩니다(기본값: true).
- `load.watchDebounceMs`: skill watcher 이벤트에 대한 디바운스(밀리초, 기본값: 250).
- `install.preferBrew`: 가능할 경우 brew 설치 관리자를 선호합니다(기본값: true).
- `install.nodeManager`: node 설치 관리자 선호도(`npm` | `pnpm` | `yarn` | `bun`, 기본값: npm).
  이는 **skill 설치**에만 영향을 미칩니다. Gateway 런타임은 여전히 Node 여야 합니다
  (WhatsApp/Telegram 에서는 Bun 을 권장하지 않음).
- `entries.<skillKey>`: skill 별 오버라이드.

Skill 별 필드:

- `enabled`: 번들되었거나 설치되어 있더라도 skill 을 비활성화하려면 `false`를 설정합니다.
- `env`: 에이전트 실행 시 주입되는 환경 변수(이미 설정되어 있지 않은 경우에만).
- `apiKey`: 기본 환경 변수를 선언하는 skills 를 위한 선택적 편의 기능.

## 참고

- `entries` 아래의 키는 기본적으로 skill 이름에 매핑됩니다. skill 이
  `metadata.openclaw.skillKey`를 정의하는 경우 해당 키를 대신 사용합니다.
- watcher 가 활성화되어 있으면 skills 변경 사항은 다음 에이전트 턴에서 반영됩니다.

### 샌드박스된 스킬 + 환경 변수

세션이 **샌드박스화된** 경우, skill 프로세스는 Docker 내부에서 실행됩니다. 샌드박스는
호스트의 `process.env`를 **상속하지 않습니다**.

다음 중 하나를 사용하십시오:

- `agents.defaults.sandbox.docker.env`(또는 에이전트 별 `agents.list[].sandbox.docker.env`)
- 사용자 정의 샌드박스 이미지에 환경 변수를 베이크하세요

전역 `env` 및 `skills.entries.<skill>.env/apiKey`는 **호스트** 실행에만 적용됩니다.
