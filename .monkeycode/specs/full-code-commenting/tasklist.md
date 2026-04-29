# 全项目代码注释与文档翻译计划

## 任务概述

- **目标**: 对全项目代码进行逐行注释，并将所有英文文档翻译为中文
- **范围**: src/, extensions/, ui/, packages/, docs/
- **文件数**: ~12,500 个 TypeScript 文件, 759 个 Markdown 文档
- **预计工期**: 分阶段执行

## 实施阶段

### 阶段一：核心模块 (src/)
- [ ] 1.1 src/entry.ts - 应用入口
- [ ] 1.2 src/index.ts - 主模块导出
- [ ] 1.3 src/library.ts - 库模式导出
- [ ] 1.4 src/cli/ - CLI 模块 (约 100 个文件)
- [ ] 1.5 src/gateway/ - Gateway 模块 (约 200 个文件)
- [ ] 1.6 src/agents/ - Agent 引擎 (约 200 个文件)
- [ ] 1.7 src/plugins/ - 插件系统 (约 50 个文件)
- [ ] 1.8 src/channels/ - 渠道模块
- [ ] 1.9 src/config/ - 配置模块
- [ ] 1.10 src/infra/ - 基础设施
- [ ] 1.11 src/commands/ - 命令系统
- [ ] 1.12 src/utils/, src/types/, src/shared/ - 工具类

### 阶段二：扩展模块 (extensions/)
- [ ] 2.1 核心 Provider 扩展 (anthropic, openai, google 等)
- [ ] 2.2 渠道扩展 (telegram, discord, slack 等)
- [ ] 2.3 工具服务扩展 (image-generation, speech 等)
- [ ] 2.4 记忆和知识扩展 (memory-*)

### 阶段三：UI 模块 (ui/)
- [ ] 3.1 ui/src/main.ts - UI 入口
- [ ] 3.2 ui/src/ui/ - UI 组件
- [ ] 3.3 ui/src/chat/ - 聊天组件
- [ ] 3.4 ui/src/components/ - 通用组件

### 阶段四：Packages 模块
- [ ] 4.1 packages/plugin-sdk/ - 插件 SDK
- [ ] 4.2 packages/memory-host-sdk/ - 记忆 SDK

### 阶段五：文档翻译
- [ ] 5.1 根目录文档 (README.md, AGENTS.md, CONTRIBUTING.md 等)
- [ ] 5.2 docs/ 目录文档
- [ ] 5.3 各模块内的 *.md 文件

## 检查点
- 每阶段完成后运行 `pnpm check` 验证
- 定期运行 `pnpm format` 格式化代码
