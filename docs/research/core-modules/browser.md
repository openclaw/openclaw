# Browser 核心模块详解

> Browser 提供浏览器自动化功能，支持导航、点击、输入、截图等操作。

## 目录

1. [Browser 概述](#browser-概述)
2. [架构设计](#架构设计)
3. [使用方式](#使用方式)
4. [高级功能](#高级功能)
5. [最佳实践](#最佳实践)

---

## Browser 概述

### 什么是 Browser？

**Browser = 浏览器自动化工具**

它可以：
- 🌐 **导航网页**：打开、跳转、历史记录
- 🖱️ **模拟操作**：点击、输入、滚动
- 📸 **截图快照**：页面截图、元素截图
- 🔍 **内容提取**：文本、HTML、数据

---

## 架构设计

### 组件图

```
Browser
│
├── Controller (控制器)
│   ├── Command Parser (命令解析)
│   ├── Session Manager (会话管理)
│   └── Error Handler (错误处理)
│
├── Engine (引擎)
│   ├── Playwright (首选)
│   └── Puppeteer (备选)
│
├── Chrome (浏览器)
│   ├── Headless (无头模式)
│   ├── Full Chrome (完整浏览器)
│   └── Chrome Extension (扩展)
│
└── Tools (工具)
    ├── browser (浏览器工具)
    ├── browser_cli (命令行)
    └── snapshot (快照)
```

### 文件结构

```
src/browser/
├── cdp.ts                    # Chrome DevTools Protocol
├── cdp-proxy-bypass.ts       # CDP 代理绕过
├── chrome-executables.ts     # Chrome 可执行文件
├── chrome-mcp.ts             # Chrome MCP
├── bridge-server.ts          # 桥接服务器
└── browser-utils.ts          # 工具函数
```

---

## 使用方式

### 1. 通过工具调用

```typescript
// 在 Agent 中使用
const result = await browser({
  action: "navigate",
  url: "https://example.com"
});

const snapshot = await browser({
  action: "snapshot",
  refs: "aria"
});

await browser({
  action: "act",
  request: {
    kind: "click",
    ref: "e12"
  }
});
```

### 2. 通过 CLI 调用

```bash
# 打开网页
openclaw browser open https://example.com

# 截图
openclaw browser screenshot --full-page

# 快照
openclaw browser snapshot --refs aria

# 点击
openclaw browser act click --ref e12

# 输入
openclaw browser act type --ref input1 --text "Hello"
```

### 3. 通过 API 调用

```typescript
// HTTP API
POST /browser/action
{
  "action": "navigate",
  "url": "https://example.com"
}

// WebSocket
{
  "type": "browser",
  "action": "snapshot",
  "params": { "refs": "aria" }
}
```

---

## 高级功能

### 1. 快照 (Snapshot)

```typescript
// 获取页面快照
const snapshot = await browser({
  action: "snapshot",
  refs: "aria",  // 或 "role"
  labels: true
});

// 返回示例
{
  "refs": {
    "e1": { "role": "button", "name": "Submit" },
    "e2": { "role": "input", "name": "Username" }
  },
  "content": "页面内容..."
}
```

### 2. 元素操作

```typescript
// 点击
await browser({
  action: "act",
  request: {
    kind: "click",
    ref: "e1"
  }
});

// 输入
await browser({
  action: "act",
  request: {
    kind: "type",
    ref: "e2",
    text: "Hello World"
  }
});

// 选择
await browser({
  action: "act",
  request: {
    kind: "select",
    ref: "e3",
    values: ["option1"]
  }
});
```

### 3. 截图

```typescript
// 全屏截图
const screenshot = await browser({
  action: "screenshot",
  fullPage: true,
  type: "png"
});

// 元素截图
const elementShot = await browser({
  action: "screenshot",
  selector: "#main-content"
});
```

### 4. 文件上传

```typescript
await browser({
  action: "upload",
  paths: ["/path/to/file.txt"]
});
```

---

## 最佳实践

### 1. 使用 ARIA 引用

```typescript
// ✅ 推荐：ARIA 引用更稳定
const snapshot = await browser({
  action: "snapshot",
  refs: "aria"
});

// ❌ 不推荐：Role 引用可能变化
const snapshot = await browser({
  action: "snapshot",
  refs: "role"
});
```

### 2. 等待元素加载

```typescript
// 等待页面加载
await browser({
  action: "navigate",
  url: "https://example.com",
  loadState: "networkidle"
});

// 等待元素出现
await browser({
  action: "act",
  request: {
    kind: "wait",
    textGone: "Loading..."
  }
});
```

### 3. 错误处理

```typescript
try {
  await browser({
    action: "navigate",
    url: "https://example.com"
  });
} catch (error) {
  if (error.code === "TIMEOUT") {
    // 超时处理
  } else if (error.code === "NAVIGATION_FAILED") {
    // 导航失败处理
  }
}
```

### 4. 资源清理

```typescript
// 使用后关闭浏览器
await browser({
  action: "close"
});

// 或设置超时自动关闭
await browser({
  action: "navigate",
  url: "https://example.com",
  timeoutMs: 30000  // 30 秒超时
});
```

---

## 配置

### Browser 配置

```json5
{
  "browser": {
    "executablePath": "/usr/bin/google-chrome",
    "headless": true,
    "defaultProfile": "openclaw",
    "args": [
      "--no-sandbox",
      "--disable-setuid-sandbox"
    ]
  }
}
```

### Chrome 扩展配置

```json5
{
  "browser": {
    "defaultProfile": "chrome",  // 使用 Chrome 扩展
    "extension": {
      "id": "openclaw-browser-relay",
      "port": 8888
    }
  }
}
```

---

*文档版本：1.0 | 更新时间：2026-03-22*
