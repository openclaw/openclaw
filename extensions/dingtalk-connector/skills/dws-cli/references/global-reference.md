# 全局参考

## 认证

```bash
# 首次: OAuth 设备流登录 (钉钉扫码授权)
dws auth login

# 查看状态
dws auth status

# 退出
dws auth logout

# 重置本地凭证 (Token 解密失败时使用)
dws auth reset
```

登录后自动管理 token 刷新，日常使用无需重复登录。

| Token | 有效期 | 说明 |
|-------|--------|------|
| Access Token | 2 小时 | 调用 API 的凭证，过期自动刷新 |
| Refresh Token | 30 天 | 换新 Access Token，使用后轮转 |

30 天内使用一次即自动续期。

### 认证失败处理
- 命令返回 `AUTH_TOKEN_EXPIRED` / `USER_TOKEN_ILLEGAL` / "Token验证失败" → 执行 `dws auth login` 重新登录

### Headless 环境 (CI/CD)

```bash
# 通过环境变量配置认证（无需交互式登录）
export DWS_CLIENT_ID=<your-app-key>
export DWS_CLIENT_SECRET=<your-app-secret>
dws auth login

# 或使用 --device 设备流登录（远程服务器/Docker）
dws auth login --device
```
refresh_token 单设备独占，远程刷新后源设备凭证失效。

## Recovery

当 runtime/MCP 命令失败且 stderr 额外输出 `RECOVERY_EVENT_ID=<event_id>` 时，说明 CLI 已经持久化了失败快照，可进入 recovery 闭环：

```bash
dws recovery plan --event-id <event_id> --format json
dws recovery execute --event-id <event_id> --format json
dws recovery finalize --event-id <event_id> --outcome recovered|failed|handoff --execution-file execution.json --format json
```

- `plan` / `execute` 也支持 `--last`，但 `--last` 与 `--event-id` 互斥
- recovery 文件保存在 `DWS_CONFIG_DIR/recovery/`
- CLI 会自动清理 30 天前的 recovery 文件和事件记录
- recovery 自己发起的文档检索与只读 probe 不会再创建新的 recovery 事件

更多闭环要求见 [recovery-guide.md](./recovery-guide.md)。


## 全局标志

| 标志 | 短名 | 说明 | 默认 |
|------|:---:|------|------|
| `--format` | `-f` | 输出格式: json / table / raw | json |
| `--jq` | | jq 表达式过滤输出 (如: `.items[] \| .name`) | 无 |
| `--fields` | | 筛选输出字段 (逗号分隔, 如: name,id,status) | 无 |
| `--verbose` | `-v` | 详细日志 | false |
| `--debug` | | 调试日志 | false |
| `--yes` | `-y` | 跳过确认提示 | false |
| `--dry-run` | | 预览操作不执行 | false |
| `--timeout` | | HTTP 超时 (秒) | 30 |
| `--mock` | | Mock 数据 (开发用) | false |
| `--client-id` | | 覆盖 OAuth Client ID | 无 |
| `--client-secret` | | 覆盖 OAuth Client Secret | 无 |

## 输出格式

### --format json (机器可读, 默认)

```json
{"success": true, "body": {...}}
```

### --format table (人类可读)

```
已创建 AI 表格 "项目管理" (UUID: abc123)

下一步:
  dws aitable base get --base-id abc123
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `DWS_CONFIG_DIR` | 覆盖默认配置目录 |
| `DWS_SERVERS_URL` | 自定义服务发现端点 |
| `DWS_CLIENT_ID` | 覆盖 OAuth Client ID (DingTalk AppKey) |
| `DWS_CLIENT_SECRET` | 覆盖 OAuth Client Secret (DingTalk AppSecret) |

凭证优先级: `--token` > `DWS_CLIENT_ID`/`DWS_CLIENT_SECRET` > OAuth 加密存储 (.data)
