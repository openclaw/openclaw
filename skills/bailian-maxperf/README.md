# Bailian MaxPerf - 百炼满血优化完整指南

## 快速开始

```bash
cd ~/.openclaw/workspace/skills/bailian-maxperf
./scripts/maxperf.sh
openclaw gateway restart
```

## 优化详情

### 1. Token Usage 兼容修复

**问题**: 百炼返回 `prompt_tokens`/`completion_tokens`，OpenClaw 读取 `input_tokens`/`output_tokens`

**修复**:
- 配置层：添加 `compat.supportsUsageInStreaming: true`
- 运行时：添加字段映射 fallback

**效果**:
```
修复前：Context: 0/128k (?%)
修复后：Context: 172k/262k (66%)
```

### 2. 模型窗口大小优化

根据阿里百炼官方文档 (2026 年最新) 更新：

| 模型 | Context Window | Max Tokens |
|------|---------------|------------|
| qwen3.5-plus | 262,144 | 65,536 |
| qwen3-max-2026-01-23 | 262,144 | 65,536 |
| qwen3-coder-next | 262,144 | 65,536 |
| qwen3-coder-plus | 262,144 | 65,536 |
| MiniMax-M2.5 | 204,800 | 131,072 |
| glm-5 | 202,752 | 16,384 |
| glm-4.7 | 202,752 | 16,384 |
| kimi-k2.5 | 262,144 | 32,768 |

### 3. 性能最佳实践

**建议配置**:
- 使用 `qwen3.5-plus` 作为主模型（平衡性能与成本）
- 长文本生成使用 `qwen3-coder-plus`（代码优化）
- 复杂推理使用 `qwen3-max-2026-01-23`（最强性能）
- 超长上下文使用 `kimi-k2.5`（262K 窗口）

### 4. 运行时补丁

修改以下文件添加字段映射：
- `auth-profiles-DDVivXkv.js`
- `auth-profiles-DRjqKE3G.js`
- `model-selection-46xMp11W.js`
- `model-selection-CU2b7bN6.js`
- `discord-CcCLMjHw.js`

修改内容：
```javascript
// 原代码
input: response.usage?.input_tokens ?? 0
output: response.usage?.output_tokens ?? 0

// 修复后
input: response.usage?.input_tokens ?? response.usage?.prompt_tokens ?? 0
output: response.usage?.output_tokens ?? response.usage?.completion_tokens ?? 0
```

## 验证清单

### ✅ 配置验证
```bash
openclaw status
# 应无配置错误
```

### ✅ Token 统计验证
```bash
# 调用百炼模型后
openclaw status
# 应显示：🧮 Tokens: XXX in / XX out
```

### ✅ Context 窗口验证
```bash
openclaw status
# 应显示精确窗口，如：📚 Context: 172k/262k (66%)
```

### ✅ 长文本生成测试
```bash
# 生成长文本应不再超时
/chat 请写一篇 5000 字的文章...
```

## 性能对比

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| Token 统计 | ❌ unknown | ✅ 精确 |
| Context 窗口 | ❌ 0/128k | ✅ 172k/262k |
| 模型窗口 | ⚠️ 部分过时 | ✅ 官方最新 |
| 配置准确性 | ⚠️ 部分过时 | ✅ 官方最新 |

## 维护说明

### 升级后修复
```bash
# OpenClaw 升级后
npm install -g openclaw@latest

# 重新运行优化脚本
cd /home/wayne/.openclaw/workspace/skills/bailian-maxperf
./scripts/maxperf.sh
openclaw gateway restart
```

### 配置备份
建议定期备份 `openclaw.json`：
```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.backup.$(date +%Y%m%d)
```

## 故障排查

### 问题 1: 配置校验失败
```bash
openclaw status
# 显示配置错误

# 解决：检查 openclaw.json 语法
python3 -m json.tool ~/.openclaw/openclaw.json > /dev/null
```

### 问题 2: Token 统计仍为 unknown
```bash
# 检查 dist 文件是否被覆盖
grep "prompt_tokens" ~/.npm-global/lib/node_modules/openclaw/dist/auth-profiles-*.js

# 如无结果，重新运行脚本
./scripts/maxperf.sh
openclaw gateway restart
```

### 问题 3: 模型窗口仍不正确
```bash
# 检查配置是否生效
grep -A5 '"qwen3.5-plus"' ~/.openclaw/openclaw.json

# 确认 contextWindow 值
# 应为 262144
```

## 相关文件

- `SKILL.md` - 技能说明
- `README.md` - 本文档
- `scripts/maxperf.sh` - 自动化脚本

## 版本历史

- **v1.0** (2026-03-18) - 初始版本
  - Token Usage 修复
  - 模型窗口优化
  - 超时配置优化
  - 自动化脚本
