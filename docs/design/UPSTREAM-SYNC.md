# OpenClaw 上游同步策略

## 仓库关系

```
upstream: https://github.com/openclaw/openclaw.git  (官方，只读)
origin:   <claworks 私有仓库>                        (ClaWorks 产品)
```

## 低冲突的关键：不改名内部标识符

以下标识符**永远不改**，确保 `git merge upstream/main` 基本无冲突：

```
src/gateway/**          不改
src/plugins/**          不改
src/agents/**           不改
src/config/**           不改
src/acp/**              不改
OpenClawConfig          不改
definePluginEntry()     不改
openclaw.plugin.json    不改（插件合约文件名）
api.runtime.*           不改
```

以下只在**表层文件**做 ClaWorks 品牌化：

```
package.json            name: claworks, bin: claworks
README.md               产品介绍
docs/                   文档品牌
claworks.mjs            入口文件名
```

## 同步步骤

```bash
# 1. 拉取上游
git fetch upstream

# 2. 查看变更
git log upstream/main --oneline -20
git diff HEAD upstream/main -- src/gateway/  # 查看关键子系统变化

# 3. 合并
git merge upstream/main

# 4. 预期冲突文件（少量，快速解决）
#    package.json: 保留 claworks name/bin，接受上游 dependencies 升级
#    README.md: 保留 ClaWorks 内容

# 5. 验证
pnpm install
pnpm build
pnpm test:changed
```

## 建议同步频率

- **重大版本**（OpenClaw x.0）：立即同步，重点检查 gateway/plugin API 变化
- **月度 beta**：每月同步一次，约 0.5-1 天工作量
- **补丁版本**：按需，安全修复优先

## 已知差异（永久维护）

| 文件 | ClaWorks 变更 | 同步时处理 |
|------|--------------|-----------|
| package.json | name=claworks, bin.claworks | 保留，接受 deps 更新 |
| claworks.mjs | 加载 claworks-robot 插件 | 保留，接受上游启动逻辑更新 |
| src/kernel/ | 新增（ClaWorks 独有）| 无冲突 |
| src/planes/ | 新增（ClaWorks 独有）| 无冲突 |
| src/interfaces/ | 新增（ClaWorks 独有）| 无冲突 |
