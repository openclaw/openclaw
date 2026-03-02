---
summary: "Skills 구성 스키마 및 예"
read_when:
  - Skills 구성을 추가하거나 수정할 때
  - 번들 허용 목록 또는 설치 동작을 조정할 때
title: "Skills 구성"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: tools/skills-config.md
workflow: 15
---

# Skills 구성

모든 Skills 관련 구성은 `~/.openclaw/openclaw.json`의 `skills` 아래에 있습니다.

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
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway 런타임은 여전히 Node; bun 권장하지 않음)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // 또는 평문 문자열
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

- `allowBundled`: **번들 Skills만**의 선택적 허용 목록. 설정되면 목록의 번들 Skills만 적격(관리/작업 공간 Skills는 영향 없음).
- `load.extraDirs`: 스캔할 추가 Skill 디렉터리(가장 낮은 우선순위).
- `load.watch`: Skill 폴더를 시청하고 Skills 스냅샷 새로고침(기본값: true).
- `load.watchDebounceMs`: Skill 감시자 이벤트용 디바운스(밀리초)(기본값: 250).
- `install.preferBrew`: 가능할 때 brew 설치 프로그램 선호(기본값: true).
- `install.nodeManager`: 노드 설치 프로그램 선호(`npm` | `pnpm` | `yarn` | `bun`, 기본값: npm).
  이는 **Skill 설치**에만 영향을 줍니다; Gateway 런타임은 여전히 Node여야 합니다
  (Bun은 WhatsApp/Telegram에는 권장하지 않음).
- `entries.<skillKey>`: 별도 Skills 오버라이드.

Skill당 필드:

- `enabled`: Skill이 번들/설치되어도 비활성화하려면 `false`로 설정.
- `env`: 에이전트 실행을 위해 주입된 환경 변수(이미 설정되지 않은 경우만).
- `apiKey`: Skill이 기본 환경 변수를 선언하는 경우의 선택적 편의입니다.
  평문 문자열 또는 SecretRef 객체(`{ source, provider, id }`)를 지원합니다.

## 참고

- `entries`의 키는 기본적으로 Skill 이름으로 매핑됩니다. Skill이 `metadata.openclaw.skillKey`를 정의하면 대신 해당 키를 사용합니다.
- 감시자가 활성화된 경우 Skill 변경 사항은 다음 에이전트 턴에 선택됩니다.

### 샌드박스된 Skills + 환경 변수

세션이 **샌드박스된** 경우 Skill 프로세스는 Docker 내에서 실행됩니다. 샌드박스
는 호스트 `process.env`를 상속하지 **않습니다**.

다음 중 하나 사용:

- `agents.defaults.sandbox.docker.env`(또는 에이전트별 `agents.list[].sandbox.docker.env`)
- 커스텀 샌드박스 이미지에 환경을 구우기

전역 `env` 및 `skills.entries.<skill>.env/apiKey`는 **호스트** 실행에만 적용됩니다.
