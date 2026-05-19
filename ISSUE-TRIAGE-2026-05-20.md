# OpenClaw Issue 深度分析报告

**日期**: 2026-05-20
**分析范围**: 最近 48h 新开 issue（5月19-20日），排除已有 PR 的
**方法**: GitHub issue 元数据 + 源码交叉验证

---

## 一、总览

| 维度                       | 数量    |
| -------------------------- | ------- |
| 近 48h 新 issue（5/19-20） | ~80     |
| 已有 open PR 关联的        | ~30     |
| **无 PR、待分析的**        | **~48** |
| 经代码验证为真实 bug       | **10**  |
| 可能是真实问题但需复现     | 6       |
| Feature Request / 非 bug   | 8       |
| 信息不足 / 不可判断        | 5       |
| 不值得修 / 边缘场景        | 7       |

---

## 二、🔴 第一梯队：必须修（代码验证确认，影响面大）

### 1. #84071 — EmbeddedAttemptSessionTakeoverError 误判 co-tenant 写入

- **标签**: P1, regression (v2026.5.17)
- **代码验证**: ✅ CONFIRMED
- **问题**: session write lock 用 fingerprint fence 检测 takeover，但**完全没有 co-tenant 意识**。合法的第二个 agent 写入同一 session 文件后，fingerprint 变化触发 false-positive takeover error → session 中断
- **影响**: 多 agent 共享 session 场景全挂，消息丢失
- **修复方向**: fence 检查需区分 "fingerprint 变了但来源合法" vs "真正的 session 劫持"
- **推荐优先级**: ⭐⭐⭐ 立刻修

### 2. #84141 — Cron 隔离 session 丢失 exec tool

- **标签**: P1, regression
- **代码验证**: ✅ CONFIRMED
- **问题**: cron executor 硬编码 `senderIsOwner: false` → exec 被 owner-only policy 过滤掉，即使 `toolsAllow` 显式包含 exec
- **影响**: 所有依赖 exec 的 cron job 静默失败。用户被迫迁移到 systemd timer
- **修复方向**: cron 执行路径应将 `toolsAllow` 中显式列出的工具视为已授权，不受 owner-only 过滤
- **推荐优先级**: ⭐⭐⭐ 立刻修

### 3. #84134 — Feishu message tool 触发 "missing tool result" 假错误

- **标签**: P1, regression (v2026.5.16+)
- **代码验证**: ✅ CONFIRMED
- **问题**: Feishu 通道的 message tool 调用成功，但 tool result 未写入 session history → transcript repair 注入 synthetic error → 用户看到 "Something went wrong"
- **影响**: Feishu 用户所有 message tool 调用都报错，虽然消息实际已发送
- **修复方向**: 追查 Feishu 消息投递后 tool result 写入的竞态条件
- **推荐优先级**: ⭐⭐⭐ 立刻修

### 4. #84068 — systemd 环境下 Update 按钮无效

- **标签**: P1
- **代码验证**: ✅ CONFIRMED
- **问题**: systemd unit 用 `KillMode=control-group`，更新时 spawn 的 detached child 被 cgroup 一起杀掉。supervised 路径虽然 exit(0) 让 systemd 重启，但 StartLimitBurst 可能阻止
- **影响**: Linux systemd 用户无法通过 UI/CLI 更新，只能手动 npm update
- **修复方向**: 改 KillMode 为 `mixed` 或 `process`，或让 update handoff 用 systemd 的 `systemctl restart` 而非自己 spawn
- **推荐优先级**: ⭐⭐⭐ 尽快修

### 5. #84249 — SSH 断开后 Discord bot 离线

- **标签**: regression (v2026.5.18)
- **代码验证**: ✅ CONFIRMED
- **问题**: Gateway 没有注册 SIGHUP handler。SSH 断开 → 终端发 SIGHUP → Node.js 默认行为是退出 → Discord 掉线
- **影响**: 所有通过 SSH 启动 gateway 的用户都受影响
- **修复方向**: 加 `process.on("SIGHUP", () => {})` 或文档建议用 nohup/tmux/systemd
- **推荐优先级**: ⭐⭐⭐ 简单修复，影响面大

---

## 三、🟡 第二梯队：应尽快修（确认或高度可能，影响中等）

### 6. #84079 — message tool 拒绝 LLM 生成的 "SendMessage"

- **代码验证**: ✅ CONFIRMED
- **问题**: `readStringParam()` 不做大小写归一化，LLM 生成 `"SendMessage"` 或 `"Send"` → 匹配失败 → 工具调用报错
- **修复**: 一行 `.toLowerCase()` 搞定
- **推荐优先级**: ⭐⭐ 简单但频繁触发

### 7. #84349 — 自定义 anthropic-messages provider 缺失 thinking profiles

- **代码验证**: ✅ CONFIRMED
- **问题**: `resolveThinkingProfile()` 只识别 bundled Anthropic provider，自定义 proxy（LiteLLM / Bifrost）用 `api: "anthropic-messages"` 时拿不到 thinking profile → `/think adaptive` 被拒绝
- **影响**: 所有通过代理使用 Claude 的用户都受影响（我们自己也是！）
- **推荐优先级**: ⭐⭐ 影响面广

### 8. #84384 — Gemini 2.5 Flash via vertex-ai 流式超时

- **代码验证**: ✅ CONFIRMED
- **问题**: OpenAI-compatible streaming parser 在 thinking token 阶段不重置 idle watchdog → 28s 超时杀连接
- **影响**: Vertex AI + Gemini 2.5 Flash 用户全部受影响
- **推荐优先级**: ⭐⭐ 但有 workaround（配置 per-provider timeout）

### 9. #84291 — Dreaming 对 >16MB recall 文件静默失败

- **代码验证**: ⚠️ LIKELY
- **问题**: 无文件大小预检，大文件可能导致 OOM 或下游 token overflow。cron list 显示 "ok" 但实际失败
- **影响**: 长期运行的重度用户。静默失败 = 数据腐蚀
- **推荐优先级**: ⭐⭐ 加 size guard + 错误上报

### 10. #84393 — Codex runtime 向非编码 agent 注入编码提示词

- **代码验证**: ⚠️ LIKELY
- **问题**: 配置了 Codex runtime 的非编码 agent 收到 "You are Codex, a coding agent..." 提示词污染
- **影响**: agent 行为错乱，安全/提示词污染
- **推荐优先级**: ⭐⭐ 影响隐蔽但严重

### 11. #84256 — `plugins update --all` 降级手动更新的插件

- **标签**: P2
- **问题**: 批量更新时用原始安装版本号覆盖手动升级的版本
- **推荐优先级**: ⭐⭐ 数据破坏性

---

## 四、🟢 第三梯队：排期修（真实问题但影响有限）

| #   | Issue  | 问题                                           | 代码验证         | 备注                 |
| --- | ------ | ---------------------------------------------- | ---------------- | -------------------- |
| 12  | #84109 | Azure AI Foundry Responses API 缺 type:message | LIKELY           | Azure 特定           |
| 13  | #84154 | Telegram 群消息记录但不触发 run                | needs-live-repro | 需复现               |
| 14  | #84139 | Compaction safeguard 导致重复消息              | P2               | sessions_send 场景   |
| 15  | #84127 | WebChat dashboard 两个回归                     | P1 但描述模糊    | issue 标题都没写好   |
| 16  | #84316 | Telegram TTS 子 agent 静默失败                 | P2               | TTS 投递路径特定     |
| 17  | #84076 | Codex app-server stall after item/completed    | P1               | Codex 特定           |
| 18  | #84305 | Codex >2M token + compaction 失败              | P1               | Codex context engine |
| 19  | #84130 | Discord 长消息分片重复                         | none             | 边缘场景             |
| 20  | #84110 | Codex prompt cache 命中率暴跌                  | P2               | 性能问题非功能问题   |
| 21  | #84120 | Signal typing indicator 不显示                 | P2               | 低影响 UX            |

---

## 五、❌ 不值得修 / 非真实问题 / Feature Request

| #      | Issue                                | 原因                                                                   |
| ------ | ------------------------------------ | ---------------------------------------------------------------------- |
| #84216 | 控制菜单加下拉框                     | Enhancement/UI wish                                                    |
| #84214 | Web UI session 切换改进              | Enhancement                                                            |
| #84246 | Wake-response 遥测事件               | Feature request (P3)                                                   |
| #84237 | Wake-inbox 持久化层                  | Feature request (P3)                                                   |
| #84209 | Session transcript 持久化 sessionKey | Enhancement                                                            |
| #84301 | Dream Diary timeout 可配置           | Config enhancement                                                     |
| #84279 | Telegram DM context 窗口开关         | Config enhancement                                                     |
| #84294 | MCP OAuth 2.1 支持                   | Feature request                                                        |
| #84113 | TUI 不渲染外部注入的 user turn       | Low-impact UX                                                          |
| #84261 | 消息重复                             | 信息严重不足，没法判断（"some chats are repeating"，无日志无复现步骤） |
| #84163 | 无响应                               | needs-info，可能是配置问题                                             |
| #84081 | 升级后 agent failed                  | 太泛，可能是多种原因，needs-info                                       |

---

## 六、与已有 issue / PR 的重叠

| 新 Issue                    | 类似的已有 issue/PR                               |
| --------------------------- | ------------------------------------------------- |
| #84386 (OAuth profile 选择) | 与 #57286 同一失败模式（已锁）                    |
| #84384 (Gemini streaming)   | PR #76080 修了 native google 但没修 OpenAI-compat |
| #84134 (Feishu tool result) | transcript repair 机制是通用的，Feishu 只是触发者 |
| #84297 (announce 身份丢失)  | PR #38235 修了 reply path，但 announce path 漏了  |

---

## 七、推荐 Commit 顺序

**如果我们要贡献修复，按"真实需要"排序（不考虑难度）：**

### 🥇 第一波（core regression，影响所有用户）

1. **#84071** — Session takeover 误判 → 多 agent 场景核心功能broken
2. **#84141** — Cron exec 工具丢失 → 定时任务核心功能 broken
3. **#84249** — SSH 断开 bot 离线 → 一行修复，影响巨大
4. **#84079** — SendMessage 大小写 → 一行修复，每天都在触发

### 🥈 第二波（channel-specific regression，特定用户群）

5. **#84134** — Feishu tool result 丢失 → Feishu 用户全受影响
6. **#84068** — systemd update 无效 → Linux 服务器用户
7. **#84349** — thinking profiles 缺失 → proxy 用户群（包括我们）

### 🥉 第三波（重要但有 workaround）

8. **#84384** — Gemini streaming 超时（有 per-provider timeout workaround）
9. **#84291** — Dreaming 大文件失败（加 size guard）
10. **#84393** — Codex prompt 污染（需要深入 Codex 内部）
