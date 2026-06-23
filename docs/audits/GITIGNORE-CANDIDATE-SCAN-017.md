# GITIGNORE-CANDIDATE-SCAN-017 — 백업/임시 파일 gitignore 후보 스캔

**Date:** 2026-06-23 12:36 KST  
**Status:** ✅ COMPLETE  
**Grade:** 🟢 Auto (read-only 분석, forbidden clean)

## 현재 untracked backup/temp 파일 목록

### 🏷️ Type A: `.bak.*` 백업 파일 (4건)

| 파일명                                              | 크기 | 생성일 | 설명                 |
| :-------------------------------------------------- | ---: | :----: | :------------------- |
| `ingress.ts.bak.policy-hotfix-001b-20260611-105903` | ~2KB |  6/11  | Telegram 핫픽스 백업 |
| `ingress.ts.bak.policy-hotfix-001c-20260611-112800` | ~2KB |  6/11  | Telegram 핫픽스 백업 |
| `send.ts.bak.block_auto_report_20260614_171858`     | ~2KB |  6/14  | Telegram 백업        |
| `send.ts.bak.hotfix_tg_push_002_20260614_173719`    | ~2KB |  6/14  | Telegram 백업        |

### 🏷️ Type B: Backup 디렉토리 (2건)

| 디렉토리                  |                                    설명 |
| :------------------------ | --------------------------------------: |
| `backups/`                | 일반 백업 디렉토리 (이름 자체가 backup) |
| `_local_backups_ignored/` |        이름에 "ignored" 포함, 로컬 전용 |

## 기존 `.gitignore` backup/temp 처리 현황

이미 존재하는 패턴:

```
*.log     ✅
*.tmp     ✅
.local/   ✅
tmp/      ✅
```

**누락된 패턴:**
| 패턴 | 미적용 확인 |
|:---|---:|
| `*.bak` | ❌ (git check-ignore 통과 못 함) |
| `*.bak.*` | ❌ |
| `backups/` | ❌ |
| `_local_backups_ignored/` | ❌ |

## 신규 ignore 추천 패턴

### 🟢 강력 추천 (리스크 0)

| 패턴                      |                 적용 대상 | 위험도 |          비고           |
| :------------------------ | ------------------------: | :----: | :---------------------: |
| `*.bak*`                  |         4건 `.bak.*` 파일 |   🟢   | 백업 파일, 코드 영향 0  |
| `backups/`                |       `backups/` 디렉토리 |   🟢   |   이름 자체가 backup    |
| `_local_backups_ignored/` | `_local_backups_ignored/` |   🟢   | "ignored"가 이름에 포함 |

### 🟡 참고 (저위험, 있으면 좋음)

| 패턴             |     적용 대상 | 위험도 |                      비고                       |
| :--------------- | ------------: | :----: | :---------------------------------------------: |
| `*.heapsnapshot` | 메모리 스냅샷 |   🟢   | 이미 `.cpuprofile`과 함께 있음 (수동 누락 확인) |
| `*.profraw`      |  프로파일 raw |   🟢   |   이미 `*.prof`와 함께 있음 (수동 누락 확인)    |

### ❌ ignore하면 안 되는 후보

| 파일                                           |                                                  사유 |
| :--------------------------------------------- | ----------------------------------------------------: |
| `docs/audits/`                                 |       15건 audit 보고서. 형이 git 관리할지 결정 필요. |
| `scripts/*.mjs`                                | bridge/preview 스크립트. 형이 git 관리할지 결정 필요. |
| `src/agents/jinhee-*.ts`                       |    진희OS 코어 에이전트. 형이 git 관리할지 결정 필요. |
| `src/plugins/plugin-*.ts`                      |    Plugin Safety 시스템. 형이 git 관리할지 결정 필요. |
| `extensions/telegram/plugin-status-message.ts` |         Telegram Plugin. 형이 git 관리할지 결정 필요. |

## `.gitignore` 수정 필요 여부

**✅ 필요.** 3줄만 추가하면 4건 `.bak.*` + 2개 디렉토리가 즉시 ignore 처리됨.

추천 추가 위치 (기존 `*.log` 패턴 근처에):

```gitignore
# Backup artifacts (telegram hotfix backups, local backup dirs)
*.bak*
backups/
_local_backups_ignored/
```

## 예상 효과

| 항목                     |   전 |       후        |
| :----------------------- | ---: | :-------------: |
| untracked 파일 수        | 28건 | **22건** (-6건) |
| workspace diff total     | 49건 |    **43건**     |
| `.bak.*` in `git status` |  4건 |   **0건** ✅    |

## 검증

| 항목                            |                                                      결과 |
| :------------------------------ | --------------------------------------------------------: |
| 현재 untracked backup/temp 파일 |                                   6건 (4 .bak.\* + 2 dir) |
| 이미 ignore 중인 패턴           |                       `*.log`, `*.tmp`, `.local/`, `tmp/` |
| 새로 ignore 추천할 패턴         |           `*.bak*`, `backups/`, `_local_backups_ignored/` |
| ignore하면 안 되는 후보         |      `docs/audits/`, `scripts/`, `src/agents/jinhee-*` 등 |
| `.gitignore` 수정 필요 여부     |                                    **✅ 필요 (3줄 추가)** |
| 다음 티켓 추천                  | `GITIGNORE-APPLY-018` (🟡 Light — .gitignore에 패턴 추가) |
| forbidden 변경 여부             |                                                   없음 ✅ |
| DB write 여부                   |                                                   없음 ✅ |
| report 위치                     |             `docs/audits/GITIGNORE-CANDIDATE-SCAN-017.md` |

## 최종 판정

```
GITIGNORE-CANDIDATE-SCAN-017: ✅ COMPLETE

backup/temp 파일:       6건 (4 .bak.* + 2 dir)
이미 ignore 중:         *.log, *.tmp (bak 없음)
신규 추천 패턴:         *.bak* / backups/ / _local_backups_ignored/
ignore 금지:            docs/audits/, scripts/, src/agents/jinhee-*, src/plugins/
.gitignore 수정 필요:   ✅ (3줄, 🟡 Light)
수정 시 untracked 감소: 28건 → 22건

다음 티켓: GITIGNORE-APPLY-018 (🟡 Light — 패턴 적용)
```
