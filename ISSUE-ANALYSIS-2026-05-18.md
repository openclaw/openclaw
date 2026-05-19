# OpenClaw Issue 分析报告 (2026-05-18)

**分析范围**: GitHub openclaw/openclaw 最新 50 个 open issues (截至 2026-05-18 22:57 CST)
**代码基线**: commit `13deea2a` (shallow clone, main HEAD)

---

## 一、筛选方法

1. 排除已有 open PR 关联的 issue（15 个）
2. 排除 Feature Request / Enhancement（纯新功能，非 bug）
3. 排除需要 live repro 但无法代码确认的（标记 `needs-live-repro` 且代码中找不到明确路径）
4. 重点关注：P1 bug、regression、数据丢失、安全问题、代码可确认的真实 bug

---

## 二、已有 PR 关联的 Issue（排除）

| #      | 标题                                      | 关联 PR         |
| ------ | ----------------------------------------- | --------------- |
| #83613 | Docker image 缺 Codex plugin              | #83626          |
| #83610 | image_generate duplicate guard            | #83614          |
| #83605 | cron task ledger miss session keys        | #83606          |
| #83601 | cron sessionKey:null 序列化为字符串       | #83618          |
| #83593 | Subagent spawn 重建 bootstrap 文件        | #83608          |
| #83574 | /model picker auth label 忽略 auth.order  | #83581          |
| #83562 | qqbot media 硬编码 ~/.openclaw/media      | #83567          |
| #83544 | browser.upload 无法访问 inbound media     | #83572          |
| #83526 | TUI Context% 显示累计值 >100%             | #83541 / #83540 |
| #83513 | Control UI reading indicator 卡住         | #83515          |
| #83507 | agent.send 自动轮换 sessionId 不触发 hook | #83523          |
| #83494 | Control UI message(send) 只显示 toolCall  | #83527 / #83497 |
| #83491 | WhatsApp runtime rebind 丢工具            | 有修复 PR       |
| #83486 | Admin HTTP RPC 跨实例执行                 | #83487          |
| #83459 | Docker 缺 trash-cli                       | #83472          |

---

## 三、Feature Request（排除）

| #      | 标题                                  | 理由         |
| ------ | ------------------------------------- | ------------ |
| #83642 | Control UI i18n                       | 纯增强       |
| #83620 | Native Latent-Space A2A Communication | 激进功能提案 |
| #83604 | memory-lancedb publicArtifacts        | 功能补全     |
| #83565 | per-turn model override               | 新功能       |
| #83564 | /status 暴露 adaptive thinking level  | 信息展示增强 |
| #83554 | native channel history preloading     | 新功能       |
| #83496 | Codex auth profile primary-first mode | 新功能       |

---

## 四、⭐ 值得修复的真实 Bug（按优先级排序）

### 🔴 Tier 1: 必须修（P1 + 代码可确认 + 影响面广）

#### 1. #83619 — K8s fsGroup EPERM chmod（P1, regression）

**问题**: 在 K8s 使用 `fsGroup` 挂载 PVC 时，exec tool 的每次调用都因 `chmod('/home/openclaw/.openclaw')` EPERM 失败。

**代码确认**:

```typescript
// src/infra/exec-approvals.ts:275
fs.chmodSync(dir, 0o700);
// ← 在 K8s fsGroup 场景下，文件归 root:fsGroup，非 root 用户无法 chmod
// 注意：只有 Windows 做了异常捕获，Linux/K8s 直接 throw!

// src/tasks/task-registry.store.sqlite.ts:448
chmodSync(dir, TASK_REGISTRY_DIR_MODE);
// ← 同样问题，无 EPERM 容错

// 对比：src/infra/tmp-openclaw-dir.ts:109 已经正确处理了 EPERM
```

**修复方案**:

- `exec-approvals.ts` 的 `ensureDir` 函数中，chmod 失败时检查 EPERM/EACCES，如果目录已可访问（accessSync W_OK|X_OK 通过），则 warn 而非 throw
- `task-registry.store.sqlite.ts` 和 `task-flow-registry.store.sqlite.ts` 同理加 try-catch
- 参考 `tmp-openclaw-dir.ts` 的处理模式

**影响面**: 所有 K8s 部署（PVC + fsGroup），每个 exec 调用都会失败 → agent 完全不可用

---

#### 2. #83577 — subagent-announce-queue collect-mode batching 跳过（P1）

**问题**: 当 announce queue 中任一 item 有 unresolved origin 时，整个 collect-mode batching 被跳过。

**代码确认**:

```typescript
// src/agents/subagent-announce-delivery.ts:476
// "Queue modes such as followup/collect apply to user prompts, not this path."
// ← 注释明确说明 subagent announce 不走 collect mode
// 但 issue 描述的是 queue settings 中的 debounceMs 和 steerMessage 路径
```

**分析**: 代码中 `queueOptions` 设置了 `steeringMode: "all"` 和 `waitForTranscriptCommit: true`。如果 transcript commit 等待超时（`transcript_commit_wait_unsupported`），会 fallback 到无 commit-wait 的重试。但如果 origin 信息不完整，`resolveRequesterSessionActivity` 可能返回空 sessionId → 直接 `{ status: "none" }`，导致 announce 丢失。

**修复方案**: 在 `loadRequesterSessionEntry` 失败或 sessionId 为空时，不应立即放弃，应尝试从 subagent registry 的 parent chain 追溯有效 session。

**影响面**: 多 subagent 并发完成时，部分 announce 静默丢失 → 用户看不到结果

---

#### 3. #83538 — cron deleteAfterRun 在 manual run 无实际执行时也触发（数据丢失）

**问题**: 手动 `cron run` 一个带 `deleteAfterRun:true` 的 job，即使实际未执行（如 already-running），job 仍被删除。

**代码确认**:

```typescript
// src/cron/service/timer.ts:892
const shouldDelete =
  job.schedule.kind === "at" && job.deleteAfterRun === true && result.status === "ok";
// ← 只检查 status === "ok"，但 manual run 路径中...

// src/cron/service/ops.ts:860
const runId = `manual:${id}:${state.deps.nowMs()}:${nextManualRunId++}`;
// manual run 调用的是同一个 run() 函数，走同一个 timer 后处理

// 关键：如果 run() 返回 { ok: true, ran: true } 但实际是 no-op（payload 为空/条件不满足）
// timer.ts 的 shouldDelete 只看 status === "ok" 不看是否真有 output
```

**修复方案**:

- `shouldDelete` 应额外检查 `result.ran !== false` 或引入 `result.hasOutput` 语义
- 或在 manual run path 中，`deleteAfterRun` 应显式 opt-in 而非继承 job 定义

**影响面**: 用户手动测试 one-shot cron job → job 被意外删除 → 必须重建

---

#### 4. #83530 — Telegram final reply 发送 stale streaming prefix（P1 级体验问题）

**问题**: Telegram 最终回复有时发的是流式过程中的中间文本，不是完整的最终回答。

**代码确认**:

```typescript
// extensions/telegram/src/bot-message-dispatch.ts:1299
const finalText = await resolveTranscriptBackedFinalText(text);
// ← 这里的 text 参数可能是 streaming 过程中捕获的 partial

// resolveTranscriptBackedFinalText 会尝试从 transcript 读取真实 final text
// 但如果 transcript 尚未 commit（race condition），则 fallback 到传入的 text
// 此时 text 就是 stale streaming prefix
```

**修复方案**:

- 增加 transcript commit 等待（带超时）
- 或在 `resolveTranscriptBackedChannelFinalText` 中，如果 transcript text 与传入 text 差异过大，延迟重试

**影响面**: Telegram 用户看到截断/不完整回复

---

#### 5. #83619 相关 — exec-approvals.ts ensureDir 在容器中无条件 throw

已包含在 #1 中。补充：`src/infra/exec-approvals.ts:434` 的 `fchmodSync` 也有同样问题。

---

### 🟡 Tier 2: 应该修（真实 bug，影响特定场景）

#### 6. #83584 — MEDIA: directive 在 API 响应中作为 raw text 传递

**问题**: 当通过 `/v1/responses` 或 `/v1/chat/completions` API 消费 OpenClaw 时，assistant 输出的 `MEDIA:` 行没有被转换为 `image_url` content block，而是直接作为文本传给调用方。

**代码确认**:

```typescript
// src/gateway/server-methods/chat.ts:404
lines.push(`MEDIA:${trimmed}`);
// ← 在构造 API 响应时，MEDIA 指令被原样拼入文本
// 没有 strip/transform 逻辑将其转为 multimodal content block
```

**修复方案**: 在 API 响应序列化路径中，检测 `MEDIA:` 行，转为 `image_url` 类型的 content block（对 chat/completions）或 `output` 中的 file block（对 responses API）。

**安全考虑**: 需要验证 MEDIA URL 是否为 managed media（非任意外部 URL）。

---

#### 7. #83641 — cerebras & deepinfra 插件注册失败 `registerModelCatalogProvider is not a function`

**问题**: 第三方 provider 插件调用 `registerModelCatalogProvider` 时报错。

**代码确认**:

```typescript
// src/plugins/model-catalog-registration.ts 导出此函数
// 但如果插件加载顺序早于 registration 模块初始化，或插件使用的 SDK 版本不匹配...
// 需要检查 plugin-sdk 的 compat export
```

**分析**: 可能是 plugin-sdk 版本升级后 breaking change，或 lazy import 时机问题。有 PR #83590 `plugin-sdk: restore legacy compat helper exports` 可能已修复。

---

#### 8. #83636 — Dynamic TTS auto-delivery 在 message-tool-only channel 中被抑制

**问题**: 当 channel 配置为只通过 message tool 投递时，TTS 自动投递逻辑被跳过。

**标签**: `fix-shape-clear` + `queueable-fix` + `source-repro` → 代码路径清晰可修

---

#### 9. #83511 — TTS final mode: text 先于 audio 发出导致 Telegram delete-and-resend

**问题**: TTS 模式下，文字版先发出再删除替换为音频，造成消息闪烁。

**标签**: `fix-shape-clear` + `queueable-fix` → 修复路径明确

---

#### 10. #83465 — Lossless-claw mini summary model 被 plugin LLM allowlist 拒绝

**问题**: 内部使用的 mini summary model 不在 plugin 的 LLM allowlist 中 → summary 失败。

**分析**: 内部调用应绕过 plugin allowlist，或 allowlist 应自动包含系统内部模型。

---

#### 11. #83484 — Telegram DM session state 在 main/peer key 之间分裂

**问题**: Telegram 1v1 DM 的 session 状态在两个 key 间不一致。

---

### 🟢 Tier 3: 可以修（低优先级/边缘场景/需更多信息）

| #      | 标题                                       | 备注                                  |
| ------ | ------------------------------------------ | ------------------------------------- |
| #83643 | Telegram + Codex OAuth stall               | 需 live repro，可能是 OAuth flow 时序 |
| #83638 | Discord announce 间歇性失败                | 需 live repro                         |
| #83624 | WebSocket sessions.send 创建错误 context   | 需 live repro                         |
| #83617 | cron model rejected by codex allowlist     | 需确认 allowlist 逻辑                 |
| #83615 | EmbeddedAttemptSessionTakeoverError        | 需 product decision                   |
| #83598 | claude-cli OAuth refresh dead-end          | 需 product decision                   |
| #83591 | Discord ingress 阻塞 main event loop       | 架构重构，需 maintainer decision      |
| #83585 | Secret reloader race condition             | 需 live repro                         |
| #83560 | openclaw configure hang                    | 需 live repro                         |
| #83557 | subagent spawn on OpenAI GPT with thinking | 需 live repro                         |
| #83546 | WebChat tool output hang                   | 需更多信息                            |
| #83532 | Web UI response delay                      | 需更多信息                            |
| #83528 | Codex runtime 延迟 inbound writes          | 已确认行为，需 design decision        |
| #83456 | RPi cron forced-run event-loop starvation  | 边缘平台                              |
| #83460 | Flaky cron isolated-agent tests            | CI 稳定性                             |

---

### ❌ 不值得修 / 不是真正的问题

| #      | 标题               | 理由                                  |
| ------ | ------------------ | ------------------------------------- |
| #83628 | README avatar 变形 | 纯 cosmetic，GitHub markdown 渲染问题 |
| #83620 | Latent-Space A2A   | 过于超前的提案，不切实际              |

---

## 五、推荐修复顺序（从"真正需要修"出发）

### 第一梯队（立即修）

1. **#83619** — K8s EPERM chmod
   - 理由：P1 regression，影响所有 K8s 部署，修复简单（加 try-catch），回归风险低
   - 改动：3 个文件，每处 ~5 行
2. **#83538** — cron deleteAfterRun 误触发
   - 理由：静默数据丢失，用户无法恢复，修复逻辑清晰
   - 改动：`timer.ts` 1 处条件增强

3. **#83577** — subagent announce batching 丢失
   - 理由：P1，多 agent 场景核心路径，丢 announce = 用户看不到结果
   - 改动：`subagent-announce-delivery.ts` origin resolution fallback

### 第二梯队（应尽快修）

4. **#83530** — Telegram stale streaming prefix
5. **#83584** — MEDIA: 指令 raw text 泄露（有安全隐患）
6. **#83636** — TTS auto-delivery 被抑制
7. **#83511** — TTS text-before-audio churn

### 第三梯队（排期修）

8. **#83641** — Plugin registration compat
9. **#83465** — Mini summary model allowlist
10. **#83484** — Telegram DM session split

---

## 六、关键代码路径备忘

| 功能                           | 文件路径                                               |
| ------------------------------ | ------------------------------------------------------ |
| exec approvals chmod           | `src/infra/exec-approvals.ts:275`                      |
| task registry chmod            | `src/tasks/task-registry.store.sqlite.ts:448`          |
| tmp dir EPERM handling (参考)  | `src/infra/tmp-openclaw-dir.ts:109`                    |
| cron deleteAfterRun 判定       | `src/cron/service/timer.ts:892`                        |
| cron manual run 入口           | `src/cron/service/ops.ts:860`                          |
| subagent announce delivery     | `src/agents/subagent-announce-delivery.ts:460-500`     |
| Telegram final text resolution | `extensions/telegram/src/bot-message-dispatch.ts:1299` |
| API response MEDIA handling    | `src/gateway/server-methods/chat.ts:404`               |

---

_分析者: 托马斯.福 | 时间: 2026-05-18 23:00 CST_
