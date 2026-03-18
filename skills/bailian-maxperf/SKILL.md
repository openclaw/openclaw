# Bailian MaxPerf - 百炼满血优化技能

## 技能目标

让阿里百炼 (Alibaba Bailian) 在 OpenClaw 中发挥**100% 性能**，包括：
- ✅ Token Usage 准确统计
- ✅ 模型窗口大小精确配置
- ✅ 超时/重试优化
- ✅ 并发性能调优
- ✅ 缓存优化

## 问题清单

### 1. Token Usage 统计失效 ❌
**现象**: `/status` 显示 `Context: 0/128k` 或 `?/1.0m`  
**原因**: 百炼返回 `prompt_tokens`/`completion_tokens`，OpenClaw 读取 `input_tokens`/`output_tokens`  
**解决**: 添加字段映射 + `supportsUsageInStreaming: true`

### 2. 模型窗口配置不准确 ⚠️
**现象**: Context 窗口与实际不符  
**原因**: 部分模型配置值过时  
**解决**: 根据阿里官方文档更新

### 3. 超时配置不合理 ⚠️
**现象**: 长文本生成易超时  
**原因**: 默认超时过短  
**解决**: 增加超时时间

### 4. 缺少重试机制 ⚠️
**现象**: 网络波动导致失败  
**原因**: 无自动重试  
**解决**: 添加重试配置

## 执行方法

```bash
cd /home/wayne/.openclaw/workspace/skills/bailian-maxperf
./scripts/maxperf.sh
```

## 优化效果

### 修复前
```
❌ Token 统计：unknown
❌ Context 窗口：0/128k (?%)
❌ 长文本：易超时
❌ 网络波动：直接失败
```

### 修复后
```
✅ Token 统计：172k/262k (66%)
✅ Context 窗口：精确匹配官方
✅ 长文本：稳定生成
✅ 网络波动：自动重试
```

## 验证方法

```bash
# 1. 配置校验
openclaw status

# 2. 调用百炼模型
/chat 使用 qwen3.5-plus 测试

# 3. 查看 token 统计
openclaw status
```

## 注意事项

⚠️ **升级后需重新执行**: `npm install -g openclaw@...` 会覆盖运行时补丁

## 相关文件

- `SKILL.md` - 本文档
- `README.md` - 详细说明
- `scripts/maxperf.sh` - 自动化脚本
- `configs/bailian-models.json` - 官方模型配置参考
