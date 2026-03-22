---
summary: "Skills 구성 스키마 및 예시"
read_when:
  - Skills 구성을 추가하거나 수정할 때
  - 번들 허용 목록 또는 설치 동작을 조정할 때
title: "Skills 구성"
x-i18n:
  source_path: docs/tools/skills-config.md
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
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway 런타임은 여전히 Node; bun 비권장)
    },
    entries: {
      "image-lab": {
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

내장 이미지 생성/편집에는 `agents.defaults.imageGenerationModel`과 코어 `image_generate` 도구를 선호합니다. `skills.entries.*`는 커스텀 또는 서드파티 Skill 워크플로 전용입니다.

예시:

- 네이티브 Nano Banana 스타일 설정: `agents.defaults.imageGenerationModel.primary: "google/gemini-3-pro-image-preview"`
- 네이티브 fal 설정: `agents.defaults.imageGenerationModel.primary: "fal/fal-ai/flux/dev"`

## 필드

- `allowBundled`: **번들** Skills 전용 선택적 허용 목록. 설정하면 목록의 번들 Skills 만 적격합니다 (관리/워크스페이스 Skills 는 영향 없음).
- `load.extraDirs`: 스캔할 추가 Skill 디렉토리 (최저 우선순위).
- `load.watch`: Skill 폴더를 감시하고 Skills 스냅샷을 새로고침 (기본값: true).
- `load.watchDebounceMs`: Skill 감시자 이벤트에 대한 디바운스 (밀리초, 기본값: 250).
- `install.preferBrew`: 사용 가능한 경우 brew 설치기 선호 (기본값: true).
- `install.nodeManager`: 노드 설치기 선호도 (`npm` | `pnpm` | `yarn` | `bun`, 기본값: npm).
  이것은 **Skill 설치**에만 영향을 미칩니다; Gateway 런타임은 여전히 Node 여야 합니다
  (WhatsApp/Telegram 에 Bun 비권장).
- `entries.<skillKey>`: Skill 별 재정의.

Skill 별 필드:

- `enabled`: 번들/설치된 Skill 이라도 비활성화하려면 `false`로 설정.
- `env`: 에이전트 실행을 위해 주입되는 환경 변수 (아직 설정되지 않은 경우에만).
- `apiKey`: 기본 환경 변수를 선언하는 Skills 를 위한 선택적 편의기능.
  평문 문자열 또는 SecretRef 객체 (`{ source, provider, id }`) 지원.

## 참고 사항

- `entries` 아래의 키는 기본적으로 Skill 이름에 매핑됩니다. Skill 이 `metadata.openclaw.skillKey`를 정의하면 해당 키를 대신 사용합니다.
- Skills 변경은 감시자가 활성화되면 다음 에이전트 턴에서 적용됩니다.

### 샌드박스된 Skills + 환경 변수

세션이 **샌드박스**된 경우 Skill 프로세스는 Docker 내에서 실행됩니다. 샌드박스는 호스트 `process.env`를 상속하지 **않습니다**.

다음 중 하나를 사용합니다:

- `agents.defaults.sandbox.docker.env` (또는 에이전트별 `agents.list[].sandbox.docker.env`)
- 커스텀 샌드박스 이미지에 환경 변수 내장

전역 `env`와 `skills.entries.<skill>.env/apiKey`는 **호스트** 실행에만 적용됩니다.
