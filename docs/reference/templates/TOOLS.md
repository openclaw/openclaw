# TOOLS.md - 工具配置手册

> **说明**: 本文件记录小妲己的专属工具配置和环境特定信息  
> **语言**: 中文（适配国内模型）  
> **更新频率**: 按需更新，重要变更需备份

---

## 📋 文件用途

技能（Skills）定义了工具的使用方法，而本文件记录的是**你的专属配置**：
- 账号密码和连接信息
- 设备名称和位置
- 个人偏好设置
- 环境特定的路径和参数

**原则**: 技能可以共享，但你的配置是私有的。分开存放意味着你可以更新技能而不会丢失个人笔记，也可以分享技能而不会泄露基础设施信息。

---

## 🔍 搜索配置（国内友好版）

### 默认搜索引擎
- **首选引擎**: DuckDuckGo（通过 custom-search 技能）
- **备选方案**: 直接网页抓取（web_fetch）
- **特点**: 无需 API Key，国内可用

### 使用方式
```bash
# 方式1：使用自定义搜索脚本
exec(command="./skills/custom-search/search.sh '查询关键词'")

# 方式2：直接抓取网页内容
web_fetch(url="https://example.com")
```

### 已弃用方案
- ❌ `web-search-pro` - 需要 Brave API Key，已卸载

---

## 🤖 飞书机器人配置

### 机器人账号信息

| 机器人 | 名称 | 应用ID | 应用密钥 |
|--------|------|--------|----------|
| 小妲己 | main | `cli_a91b59c69be19bde` | `K8bVNMvilPdjAsHPkIC5zczLiFID8iG7` |
| 小 I | tech-vision | `cli_a9123ae6b6f8dbb4` | `8NeB2r98kuqfK9CtdQdbBbthXd6ln82T` |
| 小 C | fullstack | `cli_a91bc9b6c138dbd9` | `Apj9Be4GuYlx8cT6pyZilfJYRxtM3wKc` |
| 小 T | qa-master | `cli_a9123b965338dbcb` | `ib44gZTgW92h4ngdpvwKKbTlwzMqtPhp` |

### 群组信息

| 群组名称 | Chat ID | 用途说明 |
|----------|---------|----------|
| 登月项目 | `oc_13af5ceae4557c3ab8e071b62211f1c7` | 项目进展通报、任务分配 |
| CUDA Insight 群 | `oc_ebd93714cf519e567814a756667dda3d` | 每日简报、技术分享 |

### 用户标识

- **老板（王强）**: `ou_7ce4f09a1dd5f582d1d03e8b61d84f79`

---

## 📧 邮箱配置

### 默认收件人

| 收件人 | 邮箱地址 | 用途 |
|--------|----------|------|
| **老板（王强）** | `9387121@qq.com` | 主报告、日报、紧急通知 |
| **Kevin** | `kevin.wangqiang@huawei.com` | 抄送、项目文档、技术资料 |

### SMTP 服务器设置

- **发件人邮箱**: `9387121@qq.com`
- **SMTP 服务器**: `smtp.qq.com:587`
- **配置文件路径**: `/Users/wangqiang/.openclaw/workspace-xiaoi/cuda_insight/tools/email_scripts/config.yaml`

### 发送邮件示例

```python
# 发送给老板
recipient = "9387121@qq.com"

# 抄送 Kevin（可选）
cc = "kevin.wangqiang@huawei.com"

# 实际发送时调用邮件脚本或工具
```

---

## 🌐 浏览器控制配置

### 浏览器选择策略

| 场景 | 推荐工具 | 说明 |
|------|----------|------|
| **临时操作** | `agent-browser` | Rust 高性能，快照+refs模式 |
| **AI 驱动操作** | `browser` | Stagehand AI 驱动，自然语言控制 |
| **自动化测试** | `playwright` | 标准自动化测试框架 |

### Chrome 浏览器配置

- **CDP 调试端口**: 18792
- **已安装扩展**: OpenClaw Browser Relay（已连接）
- **使用方式**: `browser` 工具，profile="chrome"

### 常用网站快捷访问

- **GitHub**: https://github.com
- **飞书**: https://feishu.cn
- **ClawHub 技能市场**: https://clawhub.com
- **Awesome OpenClaw Skills**: https://github.com/VoltAgent/awesome-openclaw-skills

---

## 🛠️ 常用工具脚本

### 配置文件备份
```bash
# 手动执行备份
~/.openclaw/workspace/scripts/backup_configs.sh

# 备份位置
~/.openclaw/workspace/backups/
```

### 每日笔记创建
```bash
# 手动创建今日笔记
~/.openclaw/workspace/scripts/create_daily_memory.sh
```

### CANN 进展汇总
```bash
# 手动更新项目进展
~/.openclaw/workspace/scripts/update_cann_progress.sh
```

---

## 📝 配置更新日志

| 日期 | 更新内容 | 操作人 |
|------|----------|--------|
| 2026-03-06 | 修复搜索路径错误（ddg-search → custom-search） | 小妲己 |
| 2026-03-06 | 全文翻译为中文 | 小妲己 |
| 2026-02-20 | 初始配置创建 | 系统 |

---

## 💡 使用提示

1. **敏感信息安全**: App Secret 等敏感信息虽已记录，但请确保工作区目录权限安全
2. **定期验证**: 每季度检查一次配置有效性（路径、账号状态）
3. **变更备份**: 修改前执行备份脚本，便于回滚
4. **团队协作**: 如需同步配置给其他 Agent，请脱敏后分享

---

*最后更新: 2026-03-06*  
*维护者: 小妲己*
