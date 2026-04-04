# feat(config): add `openclaw config recover` and generalize broken-config auto recovery

> **Based on:** OpenClaw v2026.4.1 (submit前应 rebase)

## 背景

目前 OpenClaw 的配置恢复逻辑仅覆盖一种非常窄的异常场景（update.channel clobber)。  
对于更常见的配置损坏情况（例如：openclaw.json` 被写成空文件、 JSON/JSON5 解析失败、 schema 校验失败）， gateway 启动时会直接失败，虽然磁盘上通常仍保留 `.bak` / `.bak.N` 备份，但缺少通用的自动恢复与手动恢复入口。

## 本次改动

### 1. 新增 CLI： `openclaw config recover`

```bash
# 检测当前配置是否损坏
openclaw config recover

# 只看不动
openclaw config recover --dry-run

# 指定从 bak.1 恢复
openclaw config recover --from bak.1

# JSON 输出
openclaw config recover --json
```

功能：
- 检测当前 config 是否损坏（空文件、JSON parse 失败、schema 失败)
- 枚举可恢复来源（`.bak`, `.bak.1` ~ `.bak.4`)
- 对每个备份做 parse + schema 校验
- 恢复前保存损坏文件到 `.clobbered.<timestamp>`
- 支持 `--dry-run`、 `--from`、 `--json`

### 2. 扩展自动恢复逻辑

将现有 `maybeRecoverSuspiciousConfigRead()` 从特定 clobber 场景扩展为通用损坏恢复，覆盖:
- 空文件
- JSON/JSON5 parse 失败
- schema 校验失败
- 文件体积骤降 (< 25% of last-known-good)

自动恢复时优先选择轮转备份中最近的有效备份。

### 3. gateway 启动体验改进

- 当 gateway 启动遇到损坏 config 且存在有效备份，优先自动恢复并继续启动
- 无有效备份时保持 fail closed

## 改动文件

| 文件 | 改动 |
|------|------|
| `src/config/io.ts` | 新增恢复类型、helper、`recoverConfigFile()`；扩展 `maybeRecoverSuspiciousConfigRead()`；`readConfigFileSnapshotInternal()` parse 失败时尝试自动恢复 |
| `src/config/backup-rotation.ts` | 新增 `listConfigBackupPaths()` 导出供复复用 |
| `src/config/config.ts` | 导出 `recoverConfigFile` 和 `RecoverConfigFileResult` |
| `src/cli/config-cli.ts` | 新增 `runConfigRecover()` + 注册 `recover` 子命令 |
| `src/gateway/server.impl.ts` | 启动前 invalid 时记录 recovery metadata 日志 |

## 设计原则

- 恢复前必须验证备份有效性 (parse + schema 校验)
- 恢复时保留损坏文件副本，便于排查
- 无有效恢复来源时不做 silent fallback，继续显式失败

## 代码改动详情

### `src/config/io.ts`

新增类型:
- `ConfigRecoveryFailureKind`: `"empty" | "parse" | "schema" | "suspicious"`
- `ConfigRecoveryCandidate`: 夺 { source, path, exists, fingerprint, valid, issues }
- `ConfigRecoveryPlan`: { configPath, broken, failureKind, currentIssues, candidates, selected }
- `RecoverConfigFileOptions`: { from?, dryRun? }
- `RecoverConfigFileResult`: { configPath, broken, failureKind, currentIssues, recovered, dryRun, selectedSource, restoredPath, clobberedPath, candidates }

新增函数:
- `resolveRecoveryCandidatePaths(configPath)`: 枚举 .bak ~ .bak.4 备份路径
- `validateRecoveryCandidate(deps, candidatePath)`: 校验单个备份是否有效
- `inspectCurrentConfigRecoveryState(deps, configPath)`: 判定当前配置是否损坏
- `recoverConfigFile(options, overrides)`: 执行恢复

- `readConfigFileSnapshotInternal()`: parse 失败时尝试从 `.bak` 自动恢复

扩展 `maybeRecoverSuspiciousConfigRead()`: 荢 `update-channel-only-root` 扩展为通用损坏恢复

同步修改 sync 版本 `maybeRecoverSuspiciousConfigReadSync()`

### `src/config/backup-rotation.ts`
新增 `listConfigBackupPaths(configPath)`: 夌 `${configPath}.bak`, `.bak.1` ~ `.bak.4`]

### `src/cli/config-cli.ts`
新增 `runConfigRecover()` 函数 + 注册 `recover` 子命令

### `src/config/config.ts`
导出 `recoverConfigFile` 和 `RecoverConfigFileResult`

### `src/gateway/server.impl.ts`
启动前如果 snapshot invalid，尝试 recover；记录 recovery metadata 日志

