---
read_when:
    - 스킬 구성 추가 또는 수정
    - 번들 허용 목록 또는 설치 동작 조정
summary: 기술 구성 스키마 및 예시
title: 기술 구성
x-i18n:
    generated_at: "2026-02-08T16:12:57Z"
    model: gtx
    provider: google-translate
    source_hash: e265c93da7856887c11abd92b379349181549e1a02164184d61a8d1f6b2feed5
    source_path: tools/skills-config.md
    workflow: 15
---

# 기술 구성

모든 기술 관련 구성은 `skills` ~에 `~/.openclaw/openclaw.json`.

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

## 전지

- `allowBundled`: 선택적 허용 목록 **번들로 제공** 스킬만. 설정 시에만
  목록에 있는 번들 기술은 적격합니다(관리/작업 영역 기술은 영향을 받지 않음).
- `load.extraDirs`: 스캔할 추가 스킬 디렉토리(최하위 우선순위).
- `load.watch`: 스킬 폴더를 관찰하고 스킬 스냅샷을 새로 고칩니다(기본값: true).
- `load.watchDebounceMs`: 스킬 감시자 이벤트를 밀리초 단위로 디바운스합니다(기본값: 250).
- `install.preferBrew`: 가능한 경우 Brew 설치 프로그램을 선호합니다(기본값: true).
- `install.nodeManager`: 노드 설치 프로그램 기본 설정(`npm` | `pnpm` | `yarn` | `bun`, 기본값: npm).
  이것은 단지 영향을 미칩니다 **스킬 설치**; 게이트웨이 런타임은 여전히 노드여야 합니다.
  (WhatsApp/Telegram에는 권장되지 않습니다.)
- `entries.<skillKey>`: 스킬별 재정의.

기술별 필드:

- `enabled`: 세트 `false` 번들/설치된 스킬이라도 비활성화하려면
- `env`: 에이전트 실행을 위해 삽입된 환경 변수입니다(아직 설정되지 않은 경우에만).
- `apiKey`: 기본 환경 변수를 선언하는 기술에 대한 선택적 편의입니다.

## 메모

- 아래의 키 `entries` 기본적으로 스킬 이름에 매핑됩니다. 스킬이 정의된 경우
  `metadata.openclaw.skillKey`, 대신 해당 키를 사용하세요.
- 스킬 변경 사항은 감시자가 활성화된 다음 에이전트 턴에 적용됩니다.

### 샌드박스 기술 + 환경 변수

세션이 있을 때 **샌드박스 처리된**, 기술 프로세스가 Docker 내부에서 실행됩니다. 샌드박스
않습니다 **~ 아니다** 호스트를 상속 `process.env`.

다음 중 하나를 사용하십시오.

- `agents.defaults.sandbox.docker.env` (또는 에이전트당 `agents.list[].sandbox.docker.env`)
- 환경을 사용자 정의 샌드박스 이미지에 굽습니다.

글로벌 `env` 그리고 `skills.entries.<skill>.env/apiKey` 에 적용하다 **주인** 만 실행됩니다.
