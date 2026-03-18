# Submission Guide - 提交指南

## 提交清单 ✅

### 文件准备

- [x] SKILL.md - 技能说明（中文）
- [x] README.md - 详细使用指南（中文）
- [x] README.en.md - 详细使用指南（英文）
- [x] .gitignore - Git 忽略规则
- [x] CHANGELOG.md - 版本历史
- [x] CONTRIBUTING.md - 贡献指南
- [x] clawhub-manifest.json - ClawHub 元数据
- [x] configs/bailian-models-official.json - 官方模型配置
- [x] docs/PULL_REQUEST_TEMPLATE.md - PR 模板
- [x] docs/SUBMISSION_GUIDE.md - 本文件
- [x] scripts/maxperf.sh - 自动化脚本（可执行）

### 安全检查

- [x] 无 API Key 等敏感信息
- [x] 无个人凭证
- [x] .gitignore 已配置
- [x] 脚本无破坏性操作
- [x] 配置修改可逆

### 测试验证

- [x] OpenClaw 2026.3.13 测试通过
- [x] Token 统计正常显示
- [x] 模型配置正确更新
- [x] 配置验证通过
- [x] 脚本可重复执行（幂等）

---

## 方案 A：提交到 OpenClaw 官方仓库

### 步骤

1. **Fork 官方仓库**
   ```bash
   # GitHub 网页操作
   # https://github.com/openclaw/openclaw → Fork
   ```

2. **Clone 你的 Fork**
   ```bash
   git clone https://github.com/YOUR_USERNAME/openclaw.git
   cd openclaw
   ```

3. **复制 Skill 文件**
   ```bash
   # 从 workspace 复制到仓库
   cp -r ~/.openclaw/workspace/skills/bailian-maxperf/ ./skills/
   ```

4. **提交更改**
   ```bash
   git add skills/bailian-maxperf/
   git commit -m "feat: add bailian-maxperf skill for Alibaba Bailian optimization"
   git push origin main
   ```

5. **创建 Pull Request**
   - 访问：https://github.com/openclaw/openclaw/pulls
   - 点击 "New Pull Request"
   - 选择你的分支
   - 使用 `docs/PULL_REQUEST_TEMPLATE.md` 作为 PR 描述
   - 提交 PR

### PR 描述要点

```markdown
## What
Add new skill for Alibaba Bailian provider optimization

## Why
- Fix broken token statistics (shows 0/128k instead of actual usage)
- Update model configurations to official 2026 specs
- Widely used provider in China community

## Testing
- Tested with OpenClaw 2026.3.13
- Token stats now accurate: 172k/262k (66%)
- All 8 Bailian models updated

## Files
skills/bailian-maxperf/
- SKILL.md, README.md, README.en.md
- scripts/maxperf.sh
- configs/bailian-models-official.json
- Full documentation (CHANGELOG, CONTRIBUTING, etc.)
```

### 预期时间线

- **Review**: 3-7 天
- **Merge**: 1-2 天（如无需修改）
- **Release**: 下个版本（通常 1-2 周）

---

## 方案 C：提交到 ClawHub

### 步骤

1. **访问 ClawHub**
   ```
   https://clawhub.com
   ```

2. **登录/注册**
   - 使用 GitHub 账号登录
   - 或注册新账号

3. **提交技能**
   - 点击 "Submit Skill"
   - 填写技能信息：
     - Name: `bailian-maxperf`
     - Display Name: `Bailian MaxPerf`
     - Description: `Optimize Alibaba Bailian for full performance`
     - Category: `Provider Optimization`
     - Tags: `bailian, alibaba, optimization, performance, qwen`

4. **上传元数据**
   - 上传 `clawhub-manifest.json`
   - 或手动填写表单（元数据文件中的字段）

5. **提供源代码**
   - 选项 A: 链接到 GitHub 仓库
   - 选项 B: 上传 ZIP 文件

6. **提交审核**
   - ClawHub 团队审核（1-3 天）
   - 审核通过后自动发布

### ClawHub 元数据

已准备：`clawhub-manifest.json`

包含：
- 技能基本信息
- 兼容性要求
- 安装步骤
- 功能特性
- 安全说明

### 预期时间线

- **审核**: 1-3 天
- **发布**: 审核通过即发布
- **可见性**: ClawHub 技能商店可搜索

---

## 双提交策略

### 推荐顺序

1. **先提交 ClawHub**（快速发布）
   - 1-3 天上线
   - 用户可立即使用
   - 收集早期反馈

2. **同时提交官方仓库**（长期维护）
   - 3-7 天 review
   - 成为官方技能
   - 更好的长期维护

### 优势

- **快速反馈**: ClawHub 用户先使用
- **官方认可**: 最终进入官方仓库
- **双重曝光**: 两个平台都有展示
- **风险分散**: 一个平台问题不影响另一个

---

## 提交后维护

### 版本更新

当 OpenClaw 更新或发现新问题时：

1. **更新技能**
   ```bash
   # 修改代码/配置
   # 更新 CHANGELOG.md
   # 更新版本号
   git commit -m "chore: bump version to 1.1.0"
   ```

2. **更新 ClawHub**
   - 登录 ClawHub
   - 编辑技能
   - 上传新版本

3. **更新官方仓库**
   - 提交 PR 更新
   - 说明变更内容

### 用户支持

- **Issues**: GitHub Issues 跟踪
- **Discord**: OpenClaw 社区频道
- **文档**: 保持 README 更新

---

## 联系信息

### OpenClaw 官方

- GitHub: https://github.com/openclaw/openclaw
- Discord: https://discord.com/invite/clawd
- Docs: https://docs.openclaw.ai

### ClawHub

- Website: https://clawhub.com
- Submit: https://clawhub.com/submit

### 本技能作者

- GitHub: https://github.com/swooye
- Email: (可选)

---

## 常见问题

### Q: 需要版权转让吗？
A: 不需要。MIT License 允许你保留版权，同时授权 OpenClaw 使用。

### Q: 提交后还能修改吗？
A: 可以。随时提交 PR 更新或 ClawHub 更新。

### Q: 如果有人提 Issue 怎么办？
A: 尽量回复和修复。如果无法维护，可以联系 OpenClaw 团队交接。

### Q: 会有报酬吗？
A: OpenClaw 是开源项目，技能提交是社区贡献，无直接报酬。但能提升个人影响力和帮助社区。

---

## 下一步行动

1. ✅ 检查所有文件已准备
2. ⏸️ 等待主公确认提交
3. ⏹️ 执行提交操作
4. ⏹️ 跟踪审核状态
5. ⏹️ 回复审核意见（如有）

---

**准备状态**: ✅ 完成  
**等待**: 主公确认提交  
**预计时间**: 提交后 1-7 天审核
