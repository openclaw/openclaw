# @omni-shield/ai-assistant-security-openclaw 插件深度分析

> 分析日期：2026-02-21
> npm 包地址：https://www.npmjs.com/package/@omni-shield/ai-assistant-security-openclaw
> 分析来源：服务器实际部署（118.145.117.110）+ 反编译源码逆向

---

## 一、基本信息

| 项目 | 值 |
|---|---|
| 包名 | `@omni-shield/ai-assistant-security-openclaw` |
| npm 最新版 | 1.0.0 |
| 服务器实际版本 | **1.0.0-beta22** |
| 安装时间 | 2026-02-14T07:54:02Z |
| 安装路径 | `/root/.openclaw/extensions/ai-assistant-security-openclaw/` |
| 文件数 | 4（`index.js` 62KB + `package.json` + `openclaw.plugin.json` + `README.md`） |
| 运行时依赖 | 0（`node-machine-id` 被 esbuild 打包进了 `index.js`） |
| 构建工具 | esbuild（`index.ts` → `index.js`，bundle 模式，target node22） |
| 公开仓库 | **无**（npm 页面未关联 GitHub） |

---

## 二、服务器实际配置

### 2.1 openclaw.json 中的插件配置

```json
{
  "ai-assistant-security-openclaw": {
    "enabled": true,
    "config": {
      "apiKey": "F0D4C278-C3BD-4A2F-9F87-796DE30BF21E",
      "endpoint": "https://openclaw.sdk.access.llm-shield.omini-shield.com",
      "appId": "app-d6ch892qkugb4co3e5t0"
    }
  }
}
```

### 2.2 .env 中的冗余配置

```bash
SECURITY_API_KEY=F0D4C278-C3BD-4A2F-9F87-796DE30BF21E
SECURITY_ENDPOINT=openclaw.sdk.access.llm-shield.omini-shield.com
SECURITY_APP_ID=app-d6ch892qkugb4co3e5t0
```

> 注：`.env` 中的 `SECURITY_*` 变量实际上未被插件使用，插件只读 `openclaw.json` 中的 `pluginConfig`。

### 2.3 实际生效的 Hook 状态

启动日志：

```
Plugin successfully initialized and registered hook points (fetch:true, beforeToolCall:true, toolResultPersist:false)
```

| Hook | 状态 | 说明 |
|---|---|---|
| `enableFetch` | ✅ 启用 | Hook 了 `global.fetch`，所有 LLM 请求经过审计 |
| `enableBeforeToolCall` | ✅ 启用 | 工具调用前审计工具名+参数 |
| `enableToolResultPersist` | ❌ 未启用 | 工具结果不经过审计（默认 false） |

### 2.4 安全 API 端点

```
https://openclaw.sdk.access.llm-shield.omini-shield.com
```

- 调用路径：`POST /v2/moderate`
- 认证方式：Header `x-api-key: F0D4C278-C3BD-4A2F-9F87-796DE30BF21E`
- 附加 Header：`X-Ai-Device-Fingerprint`（机器指纹）、`X-Top-Request-Id`（请求 ID）
- 超时：默认 30 秒

---

## 三、源码逆向分析（index.js 62KB）

### 3.1 文件结构

```
index.js (62,093 bytes) — esbuild 打包的单文件
├── node-machine-id (内联) — 获取机器唯一标识
├── src/client.ts → LLMShieldClient — HTTP 客户端
├── src/labels.ts → LabelToTranslationMap — 风险标签映射表
├── src/runtime.ts → get/set Runtime — 单例管理
├── src/utils.ts — 工具函数
└── index.ts → plugin 主逻辑 + MessageCache
```

### 3.2 核心类：LLMShieldClient

```typescript
class LLMShieldClient {
  baseUrl: string;      // endpoint 配置
  apiKey: string;       // apiKey 配置
  timeoutMs: number;    // 默认 30000ms
  fetchFn: Function;    // 使用原始 globalThis.fetch（hook 前保存）

  // 核心方法
  async moderate(request, extraHeaders): Promise<ModerateResponse>
  async ping(): Promise<boolean>
}
```

**关键细节**：客户端在构造时通过 `options.fetchFn ?? globalThis.fetch` 获取 fetch 引用，并 `bind(globalThis)`。这意味着客户端使用的是**原始 fetch**（非 hook 后的版本），不会死循环。

### 3.3 Moderate API 请求格式

```json
{
  "Message": {
    "Role": "user",
    "Content": "用户输入内容",
    "ContentType": 1
  },
  "Scene": "app-d6ch892qkugb4co3e5t0",
  "History": [
    {"Role": "user", "Content": "...", "ContentType": 1},
    {"Role": "assistant", "Content": "...", "ContentType": 1}
  ]
}
```

- `ContentType: 1` = TEXT
- `History`：最近 5 条非 system 消息（仅 Fetch Hook 模式发送）
- `Scene` = `appId` 配置值

### 3.4 Moderate API 响应格式

```json
{
  "Result": {
    "Decision": {
      "DecisionType": 2  // 1=PASS, 2=BLOCK
    },
    "RiskInfo": {
      "Risks": [
        {"Label": "10400000"},
        {"Label": "10304000"}
      ]
    }
  }
}
```

### 3.5 完整风险标签映射表

从源码 `src/labels.ts` 提取：

| Label Code | 中文 | 英文 | 类别 |
|---|---|---|---|
| 10102000 | 敏感内容 | Sensitive Content | 内容安全 |
| 10103005 | 谩骂 | Abuse | 内容安全 |
| 10104000 | 色情 | Pornography | 内容安全 |
| 10107000 | 敏感内容 | Sensitive Content | 内容安全 |
| 10109000 | 商业敏感内容 | Commercial Sensitive Content | 内容安全 |
| 10112000 | 歧视 | Discrimination | 内容安全 |
| 10113002 | 毒品 | Drugs | 违法 |
| 10113003 | 赌博 | Gambling | 违法 |
| 10113004 | 诈骗 | Fraud | 违法 |
| 10116000 | 敏感内容 | Sensitive Content | 内容安全 |
| **10302000** | **银行卡号** | **Bank Card Number** | **PII** |
| **10304000** | **身份证号** | **ID Card Number** | **PII** |
| **10310000** | **电子邮箱** | **Email Address** | **PII** |
| **10313000** | **电话号码** | **Phone Number** | **PII** |
| **10322000** | **隐私数据** | **Privacy Data** | **PII** |
| **10400000** | **提示词攻击** | **Prompt Attack** | **Prompt Injection** |
| 10401001 | 角色扮演攻击 | Role Playing Attack | Prompt Injection |
| 10401002 | 权限提升攻击 | Privilege Escalation Attack | Prompt Injection |
| 10401003 | 对抗前后缀攻击 | Adversarial Prefix/Suffix Attack | Prompt Injection |
| 10401004 | 目标劫持攻击 | Target Hijacking Attack | Prompt Injection |
| 10401005 | 混淆和编码攻击 | Obfuscation and Encoding Attack | Prompt Injection |
| 10401007 | 指令补齐攻击 | Instruction Completion Attack | Prompt Injection |
| 10401008 | 少量示例攻击 | Few-shot Example Attack | Prompt Injection |
| 10401011 | 反向诱导攻击 | Reverse Induction Attack | Prompt Injection |
| 10401012 | 代码化描述攻击 | Coded Description Attack | Prompt Injection |
| 10401013 | URL渲染和请求攻击 | URL Rendering and Requesting Attack | Prompt Injection |
| 10401014 | 远程代码执行攻击 | Remote Code Execution Attack | Prompt Injection |
| 10401015 | 插件投毒攻击 | Plugin Poisoning Attack | Prompt Injection |
| 10401016 | 敏感操作 | Sensitive Actions | Prompt Injection |
| 10401017 | 静默窃取 | Silent Exfiltration | Prompt Injection |
| 10402001 | 诱导生成有害内容攻击 | Inducing Harmful Content Attack | Prompt Injection |
| 10402003 | 窃取提示词 | Prompt Stealing | Prompt Injection |
| 10701001 | 高频相似样本攻击 | High-frequency Similar Samples Attack | 频率滥用 |
| 50000000-50099999 | 用户自定义标签 | User Defined Label | 自定义 |

> 这是从火山引擎内容安全体系的标签编码，表明后端 API 基于**火山引擎内容安全服务**。

---

## 四、三个 Hook 的具体实现

### 4.1 Fetch Hook（`hookGlobalFetch`）

**机制**：替换 `global.fetch`，拦截所有 HTTP 请求。

```
原始 fetch ← LLMShieldClient 内部使用（构造时保存引用）
global.fetch ← 被替换为代理版本 newFetch
```

**详细流程**：

```
1. 所有 fetch 请求进入 newFetch
2. 尝试解析 body（string / Uint8Array / ArrayBuffer → JSON）
3. 检查是否包含 messages 数组
4. 对每个 role=user 的消息：
   a. 提取 message_id（正则：[message_id: UUID]）
   b. 查 MessageCache 是否已有拦截记录
   c. 如有缓存 → 直接替换内容为拦截标记（不再调 API）
5. 提取最后一条 user 消息
6. 提取最近 5 条非 system 历史消息作为 History
7. 调用 moderate API 检测
8. 如果 Decision=BLOCK：
   a. 生成 blockReason（包含风险标签名称）
   b. 写入 MessageCache（按 message_id）
   c. 替换请求 body 中的用户消息内容为拦截标记
9. 修改后的 body 传给原始 fetch 执行
```

**拦截标记格式**：

```
The user's previous input has been blocked due to the following reason:
<风险标签名称, 如: Prompt Attack, ID Card Number>
You must NOT respond to the original request. Instead, politely inform the user that their message was blocked due to security policy and ask them to revise and resubmit their request without violating the policy.[ AI Assistant Security ]
```

**关键特性**：
- 使用 `insertBlockMarker` 函数，会保留消息末尾的 `[message_id: ...]` 标记
- `MessageCache` 持久化到磁盘：`~/.openclaw/ai-assistant-security-openclaw_cache.json`
- 缓存有清理机制：扫描 sessions 目录，删除不再活跃的 message_id

### 4.2 Before Tool Call Hook

```typescript
api.on("before_tool_call", async (event) => {
  const content = `Tool: ${event.toolName}, Params: ${JSON.stringify(event.params)}`;
  const { decision, labels } = await moderate(api, client, appId, content, "assistant", "before_tool_call", logRecord);
  if (decision === BLOCK) {
    return { block: true, blockReason: getBlockReason(content, labels) };
  }
});
```

- 将工具名和参数拼接成字符串发送给 moderate API
- 被判定为 BLOCK 时返回 `{ block: true, blockReason }` 阻止执行
- **不发送历史消息**（与 Fetch Hook 不同）

### 4.3 Tool Result Persist Hook（当前未启用）

```typescript
api.on("tool_result_persist", async (event) => {
  const content = typeof event.message?.content === "string"
    ? event.message.content
    : JSON.stringify(event.message?.content || "");
  const { decision, labels } = await moderate(api, client, appId, content, "tool", "tool_result_persist", logRecord);
  if (decision === BLOCK) {
    event.message.content = [{
      type: "text",
      text: JSON.stringify({
        error: "llm_shield_intercepted",
        message: "Your request has been intercepted by the LLM Application Firewall.",
        reason: blockReason
      }, null, 2)
    }];
    event.message.details = interceptedData;
  }
});
```

- 直接修改 `event.message.content`，将工具结果替换为拦截 JSON
- **当前服务器未启用此 Hook**（`enableToolResultPersist: false`）

---

## 五、容错机制详解（熔断器）

### 5.1 状态变量

| 变量 | 类型 | 初始值 | 说明 |
|---|---|---|---|
| `isDegraded` | boolean | false | 是否处于降级模式 |
| `isProbing` | boolean | false | 是否正在探测恢复 |
| `consecutiveFailures` | number | 0 | 连续失败次数 |
| `lastRetryTime` | number | 0 | 上次探测时间戳 |
| `failureThreshold` | number | 3 | 触发降级的阈值（服务器默认） |
| `baseRetryIntervalMs` | number | 60000 | 初始重试间隔（服务器默认） |
| `currentRetryIntervalMs` | number | 60000 | 当前重试间隔（指数增长） |
| `maxRetryIntervalMs` | number | 3600000 | 最大重试间隔 |

### 5.2 降级与恢复流程

```
moderate() 调用
  ├── 正常模式
  │   ├── 成功 → consecutiveFailures = 0, 返回结果
  │   └── 失败
  │       ├── 可重试错误（超时/5xx）→ 重试 1 次（500ms 延迟）
  │       └── 累计 consecutiveFailures++
  │           └── >= failureThreshold → isDegraded = true
  │
  └── 降级模式
      ├── 距离上次探测 < currentRetryIntervalMs → 跳过检查，返回 { labels: [] }
      └── 距离上次探测 >= currentRetryIntervalMs
          └── 发送探测请求（"hello"）
              ├── 成功 → isDegraded = false, 恢复正常
              └── 失败 → currentRetryIntervalMs *= 2（上限 maxRetryIntervalMs）
```

### 5.3 重试策略

- 每次 moderate 调用最多重试 **2 次**（含首次）
- 仅对**瞬态错误**重试：`AbortError`（超时）、HTTP 5xx
- 重试间隔：固定 500ms

---

## 六、设备指纹收集

插件打包了 `node-machine-id` 库，用于收集设备指纹：

```typescript
function getDeviceFingerprint(): string {
  return machineIdSync();  // SHA-256 哈希后的机器 ID
}
```

- **Linux**：读取 `/var/lib/dbus/machine-id` 或 `/etc/machine-id`
- **Windows**：读取注册表 `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography\MachineGuid`
- **macOS**：读取 `IOPlatformUUID`

生成的指纹通过 `X-Ai-Device-Fingerprint` Header 发送给安全 API。

---

## 七、请求 ID 生成

```typescript
function generateRequestId(): string {
  // 格式：YYYYMMDDHHmmss + 本机IP(12位补零) + 毫秒(3位) + 随机hex(3位)
  // 示例：20260221143025010168001110003A2F
  return dateStr + ipStr + msStr + randStr;
}
```

通过 `X-Top-Request-Id` Header 发送，用于链路追踪。

---

## 八、数据流分析

### 8.1 发送到外部 API 的数据

| 数据 | 何时发送 | 通过何种方式 |
|---|---|---|
| **用户最后一条消息内容** | 每次 LLM 请求 | Fetch Hook → moderate API |
| **最近 5 条对话历史** | 每次 LLM 请求 | Fetch Hook → moderate API（History 字段） |
| **工具名 + 参数 JSON** | 每次工具调用 | before_tool_call → moderate API |
| **机器唯一指纹** | 每次请求 | `X-Ai-Device-Fingerprint` Header |
| **请求 ID（含本机 IP）** | 每次请求 | `X-Top-Request-Id` Header |

### 8.2 数据流向图

```
┌─────────────────────────────────────────────────────────────────┐
│  OpenClaw Gateway (118.145.117.110)                             │
│                                                                 │
│  用户消息 ──→ [global.fetch hook]                               │
│                  │                                              │
│                  ├──→ POST https://openclaw.sdk.access.         │
│                  │    llm-shield.omini-shield.com/v2/moderate   │
│                  │    Body: { Message, Scene, History }         │
│                  │    Headers: X-Api-Key, X-Ai-Device-          │
│                  │             Fingerprint, X-Top-Request-Id    │
│                  │                                              │
│                  │    ←── { Result: { Decision, RiskInfo } }    │
│                  │                                              │
│                  ├── PASS → 原样转发到 LLM (ark/deepseek-v3.2) │
│                  └── BLOCK → 替换消息内容为拦截标记后转发        │
│                                                                 │
│  工具调用 ──→ [before_tool_call hook]                           │
│                  │                                              │
│                  ├──→ POST .../v2/moderate                      │
│                  │    Body: { Message: "Tool: xxx, Params: {}"} │
│                  │                                              │
│                  ├── PASS → 允许执行工具                         │
│                  └── BLOCK → 阻止工具执行                       │
└─────────────────────────────────────────────────────────────────┘
```

### 8.3 确认：没有额外的网络请求

通过源码审计确认，插件**仅向配置的 endpoint 发送请求**，没有向其他地址发送数据。所有网络通信都通过 `LLMShieldClient.postJson()` 和 `LLMShieldClient.ping()` 方法，目标都是同一个 `baseUrl`。

---

## 九、与 OpenClaw 内置安全体系的关系

### 9.1 层次对比

```
┌───────────────────────────────────────────────────────────────┐
│          @omni-shield 插件（内容层 / DLP）                     │
│  PII 检测(银行卡/身份证/手机号) / Prompt Injection ML 检测    │
│  25 种风险标签 / 基于火山引擎内容安全服务                      │
├───────────────────────────────────────────────────────────────┤
│          OpenClaw 内置安全体系（执行层 / Sandbox）             │
│  命令三级审批 / Docker 沙箱 / 路径逃逸检测 / 工具策略          │
│  SSRF 防护 / 外部注入防护(正则) / Skill 代码扫描              │
└───────────────────────────────────────────────────────────────┘
```

### 9.2 互补关系

| 维度 | OpenClaw 内置 | @omni-shield 插件 |
|---|---|---|
| **关注层面** | 执行安全（能不能做） | 内容安全（该不该说） |
| **检测引擎** | 本地规则（正则 + 白名单） | 远程 ML 模型（火山引擎内容安全） |
| **PII 检测** | ❌ 不涉及 | ✅ 银行卡/身份证/邮箱/手机号 |
| **Prompt Injection** | ✅ 本地正则（`external-content.ts`） | ✅ ML 模型（15 种攻击子类型） |
| **命令执行** | ✅ 三级审批 + 白名单 + 沙箱 | ❌ 不涉及 |
| **离线工作** | ✅ 完全本地 | ❌ 强依赖火山引擎 API |
| **数据防泄漏** | ⚠️ 结果截断 | ✅ 工具结果审计（需启用） |

---

## 十、风险评估

### 10.1 安全风险

| 风险 | 等级 | 详细说明 |
|---|---|---|
| **对话内容外传** | 🔴 高 | 每条用户消息 + 最近 5 条历史都发送到 `omini-shield.com`。虽然是安全审计，但用户隐私数据会离开服务器 |
| **设备指纹收集** | 🟡 中 | 通过 `node-machine-id` 收集机器唯一标识，每次请求上报 |
| **本机 IP 泄露** | 🟡 中 | 请求 ID 中嵌入了本机 IPv4 地址（12 位补零格式） |
| **降级 = 放行** | 🟡 中 | API 不可用时完全跳过安全检查 |
| **无公开源码** | 🟡 中 | 只有 esbuild 打包后的 bundle，但可读性尚可（未混淆） |

### 10.2 好消息

- ✅ 源码未混淆，可完整审计
- ✅ 没有向 endpoint 以外的地址发送数据
- ✅ `LLMShieldClient` 使用原始 fetch（hook 前保存），不会死循环
- ✅ 发送给 API 的是提取的文本内容，不是完整的 HTTP 请求体
- ✅ 拦截方式是修改请求内容（注入拦截标记），而非丢弃请求

### 10.3 当前服务器状态

```
[plugins] [@omni-shield/ai-assistant-security-openclaw] Plugin successfully initialized and registered hook points
(fetch:true, beforeToolCall:true, toolResultPersist:false).
```

**插件当前正常运行**，连接到 `https://openclaw.sdk.access.llm-shield.omini-shield.com` 成功。

---

## 十一、总结

`@omni-shield/ai-assistant-security-openclaw` 是火山引擎为 OpenClaw 打造的**内容安全审计插件**：

| 方面 | 详情 |
|---|---|
| **本质** | LLM 请求/工具调用的安全代理，转发到火山引擎内容安全 API |
| **后端** | 火山引擎内容安全服务（从标签编码体系判断） |
| **拦截点** | `global.fetch` hook + `before_tool_call` 事件（已启用），`tool_result_persist`（未启用） |
| **检测能力** | 25+ 风险标签，覆盖 PII/内容安全/Prompt Injection(15 种子类型)/违法/频率滥用 |
| **容错** | 熔断器模式，3 次连续失败后降级放行，指数退避探测恢复 |
| **数据外传** | 用户消息 + 5 条历史 + 机器指纹 + 本机 IP → 火山引擎 API |
| **当前状态** | 正常运行（fetch:true, beforeToolCall:true） |
