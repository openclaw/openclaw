# Issue: Settings UI 界面中文化不完整

## 问题描述

当前 Control UI 的**主菜单已完全中文化**，但**设置详情界面**（Settings pages）仍然大部分是英文，对中国用户不够友好。

## 现状

### ✅ 已完成
- 主菜单：完全中文
- 基础导航：已翻译
- 文档：有完整的中文文档 (`docs/zh-CN/`)
- 语言包：`zh-CN.ts` (约 13,688 行)

### ❌ 未完成
- **设置详情界面**：大部分还是英文
  - Gateway Access 设置
  - Theme 设置
  - Channels 配置详情
  - Automation 配置详情
  - Infrastructure 配置详情
- **表单标签和提示**：部分未翻译
- **错误提示**：部分未翻译

## 影响

- 中国用户在使用设置功能时需要理解英文界面
- 降低了产品的易用性
- 与已有的中文文档和主菜单不一致

## 建议解决方案

1. **补充缺失的翻译键**
   - 检查 `ui/src/i18n/locales/zh-CN.ts` 中缺失的翻译
   - 特别是 `settings.*`、`config.*`、`channels.*` 等设置相关键

2. **统一翻译风格**
   - 使用 `subsystem: message` 格式（如 `cdp: ...`）
   - 保持术语一致性

3. **测试验证**
   - 切换到中文语言后，检查所有设置页面
   - 确保没有硬编码的英文字符串

## 相关文件

- `ui/src/i18n/locales/zh-CN.ts` - 中文翻译文件
- `ui/src/i18n/locales/en.ts` - 英文原文（参考）
- `ui/src/i18n/lib/types.ts` - 翻译类型定义
- `ui/src/ui/views/config.ts` - 设置页面组件

## 优先级

**中等优先级** - 不影响核心功能，但影响用户体验

## 额外发现

在检查过程中发现 `zh-CN.ts` 缺少 `theme` 键的翻译，已修复。

---

**标签：** `i18n` `ui` `enhancement` `good first issue`
