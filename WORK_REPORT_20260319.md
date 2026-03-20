# OpenClaw 构建与修复工作报告

**日期**: 2026-03-19
**操作员**: Claude

---

## 1. 任务概述

完成 OpenClaw 项目的编译、构建，并启动 Gateway 服务，确保飞书(Feishu)插件正常工作。

---

## 2. 遇到的问题与解决方案

### 2.1 pnpm Store 损坏

**现象**:
- 多个关键包文件缺失，如 TypeScript、Undici、Zod 等
- 包目录存在但缺少核心文件（如 `bin/` 目录为空）
- `pnpm store status` 报告 "Packages in the store have been mutated"

**原因**:
- pnpm 本地缓存/存储损坏
- 可能由于 Node.js 更新过程中断导致

**解决方案**:
```bash
pnpm store prune
rm -rf node_modules
pnpm install
```

### 2.2 Windows 符号链接问题

**现象**:
- pnpm 创建的符号链接在 Windows/MSYS 环境下无法被 Node.js ESM 解析器正确识别
- 运行时错误: `Cannot find module 'E:\openclaw\node_modules\undici\index.js'`

**解决方案**:
使用 `node-linker=hoisted` 模式重新安装，将所有依赖扁平化到 `node_modules/` 目录：
```bash
echo "node-linker=hoisted" > .npmrc
rm -rf node_modules
pnpm install
```

### 2.3 jiti `tryNative` 选项导致模块导出丢失

**现象**:
- 飞书插件加载失败: `TypeError: (0 , _runtimeApi.buildChannelConfigSchema) is not a function`
- `copilot-proxy` 插件同样失败: `TypeError: (0 , _runtimeApi.definePluginEntry) is not a function`

**根因分析**:
- 插件加载器使用 jiti 来编译 TypeScript 插件
- jiti 的 `tryNative: true` 选项会尝试使用 Node.js 原生 ESM 加载器
- 但原生加载器在处理 ESM 模块的重新导出（re-exports）时会丢失部分导出
- `openclaw/plugin-sdk/feishu` 中的 `buildChannelConfigSchema` 就是这种情况

**解决方案**:
修改 `src/plugins/loader.ts`，将 `tryNative` 设置为 `false`：

```typescript
// 文件: src/plugins/loader.ts
// 行: 202-215

function buildPluginLoaderJitiOptions(aliasMap: Record<string, string>) {
  return {
    interopDefault: true,
    // NOTE: tryNative is disabled because it causes re-exported ESM modules
    // to lose their exports. Using jiti's own module resolution ensures
    // all exports are properly resolved.
    tryNative: false,  // 原为 true
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
    ...(Object.keys(aliasMap).length > 0
      ? {
          alias: aliasMap,
        }
      : {}),
  };
}
```

---

## 3. 构建步骤

### 3.1 依赖安装
```bash
# 清理并重新安装
rm -rf node_modules
pnpm install
```

### 3.2 主项目构建
```bash
pnpm build
```

### 3.3 Web UI 构建
```bash
pnpm ui:build
```

---

## 4. 最终状态

### 4.1 Gateway 服务

| 服务 | 地址 | 状态 |
|------|------|------|
| WebSocket Gateway | `ws://0.0.0.0:18789` | ✅ 运行中 |
| Control UI (Web) | `http://localhost:18789` | ✅ 可访问 |
| Canvas Host | `http://0.0.0.0:18789/__openclaw__/canvas/` | ✅ 可访问 |
| Browser Control | `http://127.0.0.1:18791/` | ✅ 可访问 |

### 4.2 飞书插件状态

| 插件模块 | 状态 | 说明 |
|----------|------|------|
| `feishu_doc` | ✅ 已注册 | 文档工具 |
| `feishu_chat` | ✅ 已注册 | 聊天工具 |
| `feishu_wiki` | ✅ 已注册 | 知识库工具 |
| `feishu_drive` | ✅ 已注册 | 云盘工具 |
| `feishu_bitable` | ✅ 已注册 | 多维表格工具 |
| `feishu_media` | ✅ 已注册 | 媒体工具 |
| `feishu_perm` | ⚠️ 已禁用 | 权限工具（默认禁用） |

---

## 5. 代码变更

### 5.1 修改的文件

| 文件 | 变更说明 |
|------|----------|
| `src/plugins/loader.ts` | 将 `tryNative` 从 `true` 改为 `false`，修复 ESM 重新导出丢失问题 |

### 5.2 新增的配置

| 文件 | 说明 |
|------|------|
| `.npmrc` | 添加 `node-linker=hoisted` 配置（后已删除，恢复默认） |

---

## 6. 待处理事项

1. **TypeScript 类型错误**: 构建过程中有一些 Discord 相关的类型错误，但不影响运行
   - `extensions/discord/src/monitor/auto-presence.ts`
   - `extensions/discord/src/monitor/provider.ts`

2. **建议提交修复**: 将 `tryNative: false` 的修改提交到主分支，避免其他 Windows 用户遇到相同问题

---

## 7. 附录：诊断命令

```bash
# 检查 pnpm store 状态
pnpm store status

# 清理 pnpm store
pnpm store prune

# 检查包是否完整
ls -la node_modules/typescript/bin/
ls -la node_modules/undici/

# 检查 plugin-sdk 导出
node -e "const m = require('./dist/plugin-sdk/feishu.js'); console.log(Object.keys(m));"

# 启动 Gateway
node openclaw.mjs gateway --verbose
```

---

**报告完成时间**: 2026-03-19 04:20
