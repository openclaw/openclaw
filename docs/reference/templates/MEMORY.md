# MEMORY.md - Long-term Memory

This file contains curated long-term memories, decisions, preferences, and important context that should persist across sessions.

## Key Decisions & Preferences

### 2026-03-06 重要决策

#### 1. 技能检查时间调整
- **决策**: 技能检查从"心跳时检查"改为"每天早上6点"
- **原因**: 确保每天固定时间执行，避免随机性
- **配置**: HEARTBEAT.md 已更新

#### 2. Agent身份定义优化
- **决策**: 完善 SOUL.md / IDENTITY.md / TOOLS.md 配置
- **内容**: 
  - 添加价值观、决策权限、错误处理流程
  - 补充能力清单（核心能力、工具使用、限制说明）
  - 扩展任务类型覆盖（14类）和优先级评估（P0-P3）
- **效果**: 角色定义更清晰，可执行性更强

#### 3. 子Agent唤醒机制确认
- **发现**: 子Agent（tech-vision/fullstack/qa-master）无cron，会话空闲后自动停止
- **解决方案**: 使用 `sessions_send` + 上下文同步唤醒
- **最佳实践**: 唤醒时携带当前项目上下文，确保无缝衔接

---

## Important Context

### 登月项目当前状态（2026-03-06）
- **Phase 1**: ✅ 已完成（小I报告✅, 小C开发✅）
- **Phase 2**: ⏳ 等待启动
- **关键阻塞**: 
  - GITEE_TOKEN未配置（影响小T测试）
  - 飞书知识库权限问题（待解决）

### Agent响应模式
- **活跃时段**: 09:00-18:00 响应率较高
- **唤醒方式**: sessions_send优于sessions_spawn（保持上下文）
- **超时处理**: 30分钟无响应需升级汇报

---

## Projects & Goals

### 🔥 登月项目（进行中）
**目标**: 构建AI多Agent协作的登月生态分析系统

**Phase 1 - 已完成（2026-02-22至2026-03-03）**:
- ✅ 小I: CUDA生态测试洞察报告V51
- ✅ 小C: gitee_client基础功能开发
- ✅ 小T: 测试方案设计

**Phase 2 - 规划中**:
- ⏳ 小I: 昇腾社区对标分析（待分配）
- ⏳ 小C: Phase 2功能开发（待分配）
- ⏳ 小T: 功能测试执行（等待TOKEN）

**里程碑**:
- [x] 2026-02-22: Agent团队创建完成
- [x] 2026-03-03: Phase 1交付完成
- [ ] 2026-03-10: Phase 2启动（预计）

### 🎯 配置优化项目（已完成）
**时间**: 2026-03-06
**成果**:
- ✅ SOUL.md 完整重构（职责、规则、流程、能力）
- ✅ IDENTITY.md 填充（Emoji头像方案）
- ✅ TOOLS.md 验证（路径有效性确认）
- ✅ 任务类型扩展（10类→14类）
- ✅ 优先级体系建立（P0-P3）

---

## People & Relationships

---
_Last updated: 2026-02-20_

## 🦞 2026-02-20 重大进化记录

### 核心能力提升

#### 1. 搜索功能完善
- **问题**: baidu-search 需要 API key 无法使用
- **解决**: 创建 `universal-search` 技能 (DuckDuckGo + Bing 自动故障转移)
- **效果**: 无需 API key 即可搜索
- **文件**: `skills/universal-search/scripts/search.py`

#### 2. Chrome 浏览器配置
- **状态**: ✅ 已配置默认使用 Chrome
- **扩展**: OpenClaw Browser Relay 已连接
- **能力**: 可以打开网页、截图、操作页面
- **限制**: 需要手动连接扩展 (安全机制)
- **成果**: 成功截图百度搜索 "openclaw"

#### 3. Mac 本地应用控制
- **发现**: 可以用 AppleScript 控制 Mac 应用
- **测试**: 成功操作豆包 Mac 应用
- **能力**: 键盘输入、鼠标点击、窗口控制
- **权限**: 需要辅助功能权限

#### 4. Mac 管理员权限优化
- **sudo 免密码**: ✅ `/etc/sudoers.d/root`
- **Touch ID for sudo**: ✅ `/etc/sudoers.d/touchid`
- **目录权限修复**: ✅ 常用目录无需密码
- **效果**: 90% 场景无需输入密码

#### 5. 技能库大幅扩充
- **初始**: 56 个技能
- **现在**: **86 个技能** (+30 个)
- **重点新增**:
  - 搜索类：baidu-search, multi-search-engine, tavily, ddg-search
  - 自我进化：evolver, capability-evolver, agent-identity-kit, cellcog
  - 开发工具：cursor-agent, docker-essentials, coding-agent
  - Moltbook 生态：molt-identity, molt-life-kernel, molt-solver 等 9 个
  - OpenClaw 生态：openclaw-mission-control, startclaw-optimizer 等 4 个
  - 监控安全：security-monitor, system-resource-monitor, monitor

#### 6. 每日检查任务
- **配置**: `HEARTBEAT.md`
- **任务**: 每天检查 awesome-openclaw-skills
- **目标**: 发现高价值技能立即分享
- **标准**: 评分>3.5、实用工具、自我进化类

#### 7. 配置文档创建
- `CHROME_SETUP.md` - Chrome 扩展配置指南
- `MAC_ADMIN_GUIDE.md` - Mac 管理完整指南
- `TOUCHID_SETUP.md` - Touch ID 配置指南
- 多个自动化脚本

### 重要配置位置

```
~/.openclaw/workspace/
├── HEARTBEAT.md              # 心跳任务配置
├── CHROME_SETUP.md           # Chrome 配置
├── MAC_ADMIN_GUIDE.md        # Mac 管理指南
├── TOUCHID_SETUP.md          # Touch ID 配置
├── MEMORY.md                 # 本文件
└── scripts/
    ├── setup_sudo_nopass.sh  # sudo 免密码
    ├── setup_touchid_sudo.sh # Touch ID 配置
    ├── fix_permissions.sh    # 权限修复
    └── universal-search/scripts/search.py
```

### 系统配置

**sudoers 配置**:
- `/etc/sudoers.d/root` - root 免密码
- `/etc/sudoers.d/touchid` - Touch ID 认证

**浏览器**:
- 默认：Chrome
- CDP 端口：18792
- 扩展：OpenClaw Browser Relay

**技能管理**:
- 安装工具：`npx clawhub install <skill>`
- 技能目录：`~/.openclaw/workspace/skills/`

### 行为改进

**之前**:
- ❌ 遇到网络问题就卡死
- ❌ 被动等待指令
- ❌ 技能少，能力有限
- ❌ 频繁输入管理员密码

**现在**:
- ✅ 主动尝试备用方案
- ✅ 主动使用 86 个技能
- ✅ 可以操作 Mac 应用
- ✅ Touch ID/免密码，高效管理

### 每日任务

**心跳检查** (每 15 分钟):
- 检查 subagents
- 通知所有群组

**每日检查** (每天一次):
- 查看 awesome-openclaw-skills
- 发现高价值技能分享给用户

### 关键教训

1. **网络阻塞处理**: 使用超时控制 + 重试机制 + 备用方案
2. **浏览器限制**: 扩展连接需要用户手动确认 (安全机制)
3. **Mac 权限**: 辅助功能权限是控制应用的前提
4. **技能管理**: 定期检查和更新技能库
5. **主动进化**: 每天学习新技能，持续改进

### 用户偏好

- **搜索**: 优先使用免 API 的多引擎搜索
- **浏览器**: Chrome + 扩展连接
- **Mac 管理**: Touch ID + 免密码 sudo
- **技能安装**: 优先评分>3.5 的实用技能
- **信息获取**: 主动搜索，不卡死等待

### 📧 默认邮箱配置（重要）

| 收件人 | 邮箱地址 | 用途 |
|--------|---------|------|
| **老板 (王强)** | `9387121@qq.com` | 主报告、日报、通知 - **默认收件人** |
| **Kevin** | `kevin.wangqiang@huawei.com` | 抄送、项目文档 |

**SMTP 配置**:
- 发件人：`9387121@qq.com`
- SMTP 服务器：`smtp.qq.com:587`
- 配置文件：`/Users/wangqiang/.openclaw/workspace-xiaoi/cuda_insight/tools/email_scripts/config.yaml`

**使用规则**:
- 老板要求发送文件/报告 → 默认发到 `9387121@qq.com`
- 需要抄送 Kevin → 同时发送到两个邮箱
- 小 I 的 docs 打包任务 → 发送后在群里同步

---

## 🤖 CANN 项目专家 Agent 团队

**创建时间**: 2026-02-22 (用户手动创建)

### 团队成员

| Agent ID | 名称 | 角色 | Workspace | Agent 目录 |
|----------|------|------|-----------|------------|
| `tech-vision` | 洞察专家 - 小 I | 技术架构/趋势/优化 | `~/.openclaw/workspace-xiaoi` | `~/.openclaw/agents/tech-vision/agent` |
| `fullstack` | 全栈码农 - 小 C | 开发/部署/运维 | `~/.openclaw/workspace-fullstack` | `~/.openclaw/agents/fullstack/agent` |
| `qa-master` | 测试专家 - 小 T | 测试/质量保障 | `~/.openclaw/workspace-qa-master` | `~/.openclaw/agents/qa-master/agent` |

### 配置位置

- **配置文件**: `~/.openclaw/openclaw.json`
- **配置项**: `agents.list`, `tools.agentToAgent`, `bindings`, `channels.feishu.accounts`
- **Cron Jobs**: `~/.openclaw/cron/jobs.json`
- **Feishu Bot**: 每个 Agent 有独立的飞书 Bot 账号

### 群组信息

| 群组 | Chat ID | 用途 |
|------|---------|------|
| **登月项目** | `oc_13af5ceae4557c3ab8e071b62211f1c7` | 登月项目进展通报、任务分配 |
| CUDA Insight 群 | `oc_ebd93714cf519e567814a756667dda3d` | CUDA 每日简报 |

### 各 Agent Chat 目标

| Agent | Bot Name | App ID | 默认 Chat 目标 |
|-------|----------|--------|---------------|
| 小妲己 | main | `cli_a91b59c69be19bde` | `user:ou_7ce4f09a1dd5f582d1d03e8b61d84f79` |
| 小 I | tech-vision | `cli_a9123ae6b6f8dbb4` | `chat:oc_13af5ceae4557c3ab8e071b62211f1c7` |
| 小 C | fullstack | `cli_a91bc9b6c138dbd9` | `chat:oc_13af5ceae4557c3ab8e071b62211f1c7` |
| 小 T | qa-master | `cli_a9123b965338dbcb` | `chat:oc_13af5ceae4557c3ab8e071b62211f1c7` |

### 协作方式

- 小妲己 (main) 负责任务协调和汇总
- 小 I 负责技术架构和趋势分析
- 小 C 负责代码实现和部署运维
- 小 T 负责测试方案和质量保障
- 通过 **Feishu Bot** 进行通信（异步）
- 通过 **Cron Jobs** 定期通报进展

### Cron Jobs 配置

| Job Name | Schedule | 投递目标 | 状态 |
|----------|----------|----------|------|
| CANN 项目进展通报 | Every 3h | `chat:oc_13af5ceae4557c3ab8e071b62211f1c7` | ✅ 已配置 |
| CUDA Insight Daily Briefing | Daily 7:00 | `chat:oc_ebd93714cf519e567814a756667dda3d` | ⚠️ 发送失败 |

---
## 自动上下文优化记录
2026 年 2 月 16 日 星期一 12 时 43 分 22 秒 CST: 触发上下文使用率监控优化
- 当前 MEMORY.md 行数：24 行
- 上次优化位置：第 21 行
- 上下文使用率：12.5% (低于 80% 阈值，无需紧急优化)
- 保持监控状态
