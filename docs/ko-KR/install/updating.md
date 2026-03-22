---
title: "업데이트"
summary: "OpenClaw 안전하게 업데이트 (전역 설치 또는 소스), 롤백 전략 포함"
read_when:
  - OpenClaw 업데이트 시
  - 업데이트 후 문제가 발생했을 때
x-i18n:
  source_path: docs/install/updating.md
---

# 업데이트

OpenClaw 를 최신 상태로 유지합니다.

## 권장: `openclaw update`

가장 빠른 업데이트 방법입니다. 설치 유형 (npm 또는 git) 을 감지하고, 최신 버전을 가져오고, `openclaw doctor` 를 실행하고, Gateway 를 재시작합니다.

```bash
openclaw update
```

채널을 전환하거나 특정 버전을 대상으로 하려면:

```bash
openclaw update --channel beta
openclaw update --tag main
openclaw update --dry-run   # 적용 없이 미리보기
```

채널 의미론에 대해서는 [릴리스 채널](/install/development-channels)을 참고하세요.

## 대안: 설치 스크립트 재실행

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

온보딩을 건너뛰려면 `--no-onboard` 를 추가하세요. 소스 설치의 경우 `--install-method git --no-onboard` 를 전달하세요.

## 대안: 수동 npm 또는 pnpm

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

## 자동 업데이트

자동 업데이트는 기본적으로 비활성화되어 있습니다. `~/.openclaw/openclaw.json` 에서 활성화하세요:

```json5
{
  update: {
    channel: "stable",
    auto: {
      enabled: true,
      stableDelayHours: 6,
      stableJitterHours: 12,
      betaCheckIntervalHours: 1,
    },
  },
}
```

| 채널     | 동작                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- |
| `stable` | `stableDelayHours` 만큼 대기한 다음 `stableJitterHours` 에 걸쳐 결정론적 지터로 적용 (분산 롤아웃). |
| `beta`   | `betaCheckIntervalHours` (기본: 매시간) 마다 확인하고 즉시 적용.                                    |
| `dev`    | 자동 적용 없음. `openclaw update` 를 수동으로 사용하세요.                                           |

Gateway 는 시작 시 업데이트 힌트도 로그합니다 (`update.checkOnStart: false` 로 비활성화).

## 업데이트 후

<Steps>

### Doctor 실행

```bash
openclaw doctor
```

설정 마이그레이션, DM 정책 감사 및 Gateway 상태를 확인합니다. 세부사항: [Doctor](/gateway/doctor)

### Gateway 재시작

```bash
openclaw gateway restart
```

### 확인

```bash
openclaw health
```

</Steps>

## 롤백

### 버전 고정 (npm)

```bash
npm i -g openclaw@<version>
openclaw doctor
openclaw gateway restart
```

팁: `npm view openclaw version` 은 현재 게시된 버전을 보여줍니다.

### 커밋 고정 (소스)

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
pnpm install && pnpm build
openclaw gateway restart
```

최신으로 돌아가려면: `git checkout main && git pull`.

## 문제가 해결되지 않을 때

- `openclaw doctor` 를 다시 실행하고 출력을 주의 깊게 읽어보세요.
- 확인: [문제 해결](/gateway/troubleshooting)
- Discord 에서 문의하세요: [https://discord.gg/clawd](https://discord.gg/clawd)
