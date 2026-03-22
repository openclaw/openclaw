---
title: "플러그인 SDK 마이그레이션"
sidebarTitle: "SDK 마이그레이션"
summary: "레거시 하위 호환성 레이어에서 최신 플러그인 SDK 로 마이그레이션"
read_when:
  - OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED 경고를 볼 때
  - OPENCLAW_EXTENSION_API_DEPRECATED 경고를 볼 때
  - 플러그인을 최신 플러그인 아키텍처로 업데이트할 때
  - 외부 OpenClaw 플러그인을 유지관리할 때
x-i18n:
  source_path: docs/plugins/sdk-migration.md
---

# 플러그인 SDK 마이그레이션

OpenClaw 은 넓은 하위 호환성 레이어에서 집중적이고 문서화된 임포트를 가진 최신 플러그인 아키텍처로 전환했습니다. 새 아키텍처 이전에 빌드된 플러그인이 있다면 이 가이드가 마이그레이션을 도와줍니다.

## 변경 사항

이전 플러그인 시스템은 플러그인이 단일 진입점에서 필요한 모든 것을 임포트할 수 있는 두 가지 광범위한 표면을 제공했습니다:

- **`openclaw/plugin-sdk/compat`** — 수십 개의 헬퍼를 다시 내보내는 단일 임포트.
- **`openclaw/extension-api`** — 플러그인에 내장 에이전트 러너와 같은 호스트 측 헬퍼에 대한 직접 접근을 제공하는 브리지.

두 표면 모두 현재 **더 이상 사용되지 않습니다**. 런타임에서는 여전히 작동하지만, 새 플러그인은 이를 사용해서는 안 되며 기존 플러그인은 다음 주요 릴리스에서 제거되기 전에 마이그레이션해야 합니다.

<Warning>
  하위 호환성 레이어는 향후 주요 릴리스에서 제거됩니다.
  이러한 표면에서 여전히 임포트하는 플러그인은 그때 중단됩니다.
</Warning>

## 마이그레이션 방법

<Steps>
  <Step title="더 이상 사용되지 않는 임포트 찾기">
    더 이상 사용되지 않는 표면에서의 임포트를 플러그인에서 검색합니다:

    ```bash
    grep -r "plugin-sdk/compat" my-plugin/
    grep -r "openclaw/extension-api" my-plugin/
    ```

  </Step>

  <Step title="집중된 임포트로 교체">
    이전 표면의 각 내보내기는 특정 최신 임포트 경로에 매핑됩니다:

    ```typescript
    // 이전 (더 이상 사용되지 않는 하위 호환성 레이어)
    import {
      createChannelReplyPipeline,
      createPluginRuntimeStore,
      resolveControlCommandGate,
    } from "openclaw/plugin-sdk/compat";

    // 이후 (최신 집중 임포트)
    import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
    import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
    import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
    ```

    호스트 측 헬퍼의 경우 직접 임포트 대신 주입된 플러그인 런타임을 사용합니다:

    ```typescript
    // 이전 (더 이상 사용되지 않는 extension-api 브리지)
    import { runEmbeddedPiAgent } from "openclaw/extension-api";
    const result = await runEmbeddedPiAgent({ sessionId, prompt });

    // 이후 (주입된 런타임)
    const result = await api.runtime.agent.runEmbeddedPiAgent({ sessionId, prompt });
    ```

  </Step>

  <Step title="빌드 및 테스트">
    ```bash
    pnpm build
    pnpm test -- my-plugin/
    ```
  </Step>
</Steps>

## 제거 타임라인

| 시점                 | 발생 사항                                                              |
| -------------------- | ---------------------------------------------------------------------- |
| **현재**             | 더 이상 사용되지 않는 표면이 런타임 경고를 출력                        |
| **다음 주요 릴리스** | 더 이상 사용되지 않는 표면이 제거됨; 여전히 사용하는 플러그인이 실패함 |

모든 코어 플러그인은 이미 마이그레이션되었습니다. 외부 플러그인은 다음 주요 릴리스 전에 마이그레이션해야 합니다.

## 임시로 경고 억제

마이그레이션 작업 중 다음 환경 변수를 설정합니다:

```bash
OPENCLAW_SUPPRESS_PLUGIN_SDK_COMPAT_WARNING=1 openclaw gateway run
OPENCLAW_SUPPRESS_EXTENSION_API_WARNING=1 openclaw gateway run
```

이것은 영구적인 해결책이 아닌 임시 탈출구입니다.

## 관련 문서

- [플러그인 만들기](/plugins/building-plugins)
- [플러그인 내부 구조](/plugins/architecture)
- [플러그인 매니페스트](/plugins/manifest)
