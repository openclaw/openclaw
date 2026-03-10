# Chain Memory Backend - 项目文档与教训

> 最后更新: 2026-03-10
> 作者: Tutu (AI Assistant)

---

## 📋 目录

1. [项目概述](#项目概述)
2. [当前设计](#当前设计)
3. [代码结构](#代码结构)
4. [提交历史与演进](#提交历史与演进)
5. [犯过的错误](#犯过的错误)
6. [根本原因分析](#根本原因分析)
7. [最佳实践](#最佳实践)
8. [开发前必读](#开发前必读)

---

## 项目概述

### 目标

为 OpenClaw 实现一个 **Chain Memory Backend**，支持：

- 多 Provider 链式调用（Primary → Secondary → Fallback）
- 故障隔离（Circuit Breaker）
- 优雅降级
- 100% 向后兼容

### 当前状态

- ✅ 基本功能可用（read 路径完整）
- ⚠️ Async write 功能已移除（接口不支持）
- ⚠️ 经历 12 次提交才稳定
- ✅ 测试覆盖率 96.61%
- ✅ 57 个测试全部通过

---

## 当前设计

### 核心架构

```
┌─────────────────────────────────────────────────────────┐
│                  MemorySearchManager                     │
│              (getMemorySearchManager)                    │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│               ChainMemoryManager                         │
│  - search(query) → Primary → Secondary → Fallback       │
│  - readFile(path) → Primary → Secondary → Fallback      │
│  - probeEmbeddingAvailability() → fallback chain        │
│  - probeVectorAvailability() → fallback chain           │
│  - status() → health Map → plain object                 │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│              getBackendManager(provider)                 │
│  - builtin: getMemorySearchManager()                    │
│  - qmd: createQMDProvider()                             │
│  - plugin: loadPlugin()                                 │
└─────────────────────────────────────────────────────────┘
```

### 配置结构

```typescript
interface ChainMemoryConfig {
  backend: "chain";
  chain: {
    primary: ProviderConfig; // 必需
    secondary?: ProviderConfig; // 可选
    fallback?: ProviderConfig; // 可选
  };
  // 已移除:
  // - writeMode
  // - enableAsyncWrite
}
```

### 关键设计决策

1. **Async Factory Pattern**
   - ChainMemoryManager.create() 是异步的
   - 因为需要初始化所有 providers
   - 返回 Promise<ChainMemoryManager>

2. **Manager Cache**
   - 使用 CHAIN_MANAGER_CACHE 缓存已创建的 managers
   - Key: `agentId:primaryHash:secondaryHash:fallbackHash`
   - 防止每次调用都创建新实例（资源泄漏）

3. **Fallback 顺序**
   - search/readFile: Primary → Secondary → Fallback
   - probe 方法: 同样的 fallback 顺序
   - 任一成功即返回，全部失败才抛错

4. **Health Status**
   - status() 返回 Map，需要转换为 plain object
   - 因为 JSON.stringify(Map) 返回 {}

---

## 代码结构

### 文件组织

```
src/memory/chain/
├── index.ts              # 导出 + create() factory
├── manager.ts            # ChainMemoryManager 核心逻辑
├── types.ts              # 类型定义
├── wrapper.ts            # ProviderWrapper（单 provider 包装）
├── circuit-breaker.ts    # 熔断器
├── health-monitor.ts     # 健康监控

src/memory/
├── backend-config.ts     # resolveChainConfig + getBackendManager
├── search-manager.ts     # getMemorySearchManager + cache

src/config/
├── types.memory.ts       # ChainMemoryConfig 类型

test/memory/chain/
├── config-validation.test.ts
├── integration.test.ts
├── e2e.test.ts
├── stress.test.ts
```

### 关键类和函数

#### ChainMemoryManager (manager.ts)

```typescript
class ChainMemoryManager implements MemorySearchManager {
  private providers: ProviderWrapper[];
  private fallback?: ProviderWrapper;

  async search(query: MemoryQuery): Promise<MemorySearchResult>;
  async readFile(path: string): Promise<string | undefined>;
  async probeEmbeddingAvailability(): Promise<boolean>;
  async probeVectorAvailability(): Promise<boolean>;
  async status(): Promise<MemoryProviderStatus>;
  async close(): Promise<void>;

  static async create(options): Promise<ChainMemoryManager>;
}
```

#### getBackendManager (search-manager.ts)

```typescript
async function getBackendManager(
  provider: ProviderConfig,
  agentId: string,
  purpose?: "full" | "status",
): Promise<MemorySearchManager | QMDProvider | PluginProvider>;
```

#### resolveChainConfig (backend-config.ts)

```typescript
function resolveChainConfig(
  chain: ChainMemoryConfig["chain"],
  globalConfig: GlobalConfig,
): ResolvedChainConfig;
```

---

## 提交历史与演进

### 时间线

| Commit    | 时间        | 内容                 | 引入的问题                   |
| --------- | ----------- | -------------------- | ---------------------------- |
| be92a6daf | 03-09 15:30 | 初始提交             | 大量 placeholder，无集成测试 |
| efc1de815 | 03-09 16:01 | 修复 health-monitor  | 未发现 create() 不存在       |
| 43ded2d84 | 03-09 16:23 | "禁用" async queue   | 整个功能是假的               |
| 381eeb3e0 | 03-09 16:46 | 修复 import path     | 未发现 probe 逻辑不完整      |
| af515143a | 03-09 16:56 | 实现 probe 方法      | 只检查 primary               |
| f1611e74d | 03-09 17:08 | 替换中文注释         | -                            |
| e3886d86f | 03-09 23:06 | 修复 TypeScript 错误 | 引入新复杂度                 |
| 944503662 | 03-10 11:05 | 实现真正 factory     | 重写核心逻辑                 |
| 6ebf88644 | 03-10 11:22 | 删除 async queue     | 功能完全移除                 |
| 381ed4845 | 03-10 11:51 | 添加缓存             | probe 仍无 fallback          |
| faca882de | 03-10 12:06 | probe 添加 fallback  | -                            |
| 1cd5268c4 | 03-10 13:24 | 修复测试 import      | -                            |

### 演进过程分析

#### 第一阶段：初始提交 (be92a6daf)

**问题**:

- 代码里有 `throw new Error('Not implemented')`
- AsyncWriteQueue 调用 `provider.search()` 而不是 write
- 没有集成测试

**为什么会这样**:

- 过于依赖 AI 生成的代码
- 只跑了单元测试，没有测试完整路径
- 没有理解 MemorySearchManager 接口的限制

#### 第二阶段：修补阶段 (efc1de815 - af515143a)

**问题**:

- 每次只修复表面问题
- 没有重新审视整体设计
- 依赖外部审查发现问题

**为什么会这样**:

- 急于"修复"，没有深入分析
- 没有运行集成测试验证
- 没有思考"这个修复会不会破坏其他地方"

#### 第三阶段：重构阶段 (944503662 - 6ebf88644)

**问题**:

- 不得不重写核心逻辑
- 删除了"假的功能"

**为什么会这样**:

- 最初的 placeholder 根本无法工作
- 必须推倒重来

#### 第四阶段：完善阶段 (381ed4845 - 1cd5268c4)

**改进**:

- 添加缓存防止资源泄漏
- probe 方法添加 fallback
- 修复测试问题

**仍然依赖外部审查**:

- 每次都是 Codex bot 发现问题才修复

---

## 犯过的错误

### 1. 设计阶段错误

#### ❌ 错误 1.1: 包含未实现的功能

```typescript
// 初始代码
async function getBackendManager() {
  throw new Error("Not implemented"); // ❌ 这根本不能工作
}
```

**教训**:

- 不要提交 placeholder 代码
- 如果功能未实现，就不要包含在初始提交中
- 或者明确标记为 TODO 并在文档中说明

#### ❌ 错误 1.2: 没有理解接口限制

```typescript
// AsyncWriteQueue 假设 MemorySearchManager 有 write 方法
interface MemorySearchManager {
  search(query): Promise<Result>;
  // ❌ 实际上没有 add/update/delete 方法
}
```

**教训**:

- 使用接口前先检查定义
- 不要假设接口有你需要的方法
- 如果需要扩展接口，先讨论

#### ❌ 错误 1.3: 缺少集成测试

```typescript
// 只有单元测试
test('CircuitBreaker works', () => { ... })
test('AsyncWriteQueue works', () => { ... })

// ❌ 没有测试完整路径
// test('chain backend search works end-to-end', async () => {
//   const manager = await getMemorySearchManager({ backend: 'chain', ... })
//   const result = await manager.search('test')
// })
```

**教训**:

- 单元测试不够，必须有集成测试
- 测试真实的使用场景
- 测试完整的数据流

### 2. 实现阶段错误

#### ❌ 错误 2.1: "禁用"而不是修复

```typescript
// 43ded2d84
async process(task) {
  // ❌ 只是注释掉错误代码，没有真正修复
  // const result = await provider.search(task.data)
  console.warn('Async write not implemented')
}
```

**教训**:

- 如果功能不能工作，就删除它
- 不要保留"禁用"的代码
- 或者标记为 TODO 并创建 issue

#### ❌ 错误 2.2: 不完整的修复

```typescript
// af515143a
async probeEmbeddingAvailability() {
  // ❌ 只检查 primary
  return this.providers[0].probeEmbeddingAvailability()
}

// 正确做法 (faca882de)
async probeEmbeddingAvailability() {
  for (const provider of this.providers) {
    if (await provider.probeEmbeddingAvailability()) return true
  }
  return false
}
```

**教训**:

- 修复要完整，考虑所有情况
- 参考已有的类似代码（search/readFile 都有 fallback）
- 保持一致性

#### ❌ 错误 2.3: 引入资源泄漏

```typescript
// 944503662 - 每次调用都创建新 manager
async function getMemorySearchManager(config) {
  if (config.backend === 'chain') {
    return ChainMemoryManager.create(...)  // ❌ 没有缓存
  }
}

// 修复 (381ed4845) - 添加缓存
const CHAIN_MANAGER_CACHE = new Map()
async function getMemorySearchManager(config) {
  const key = buildChainCacheKey(config)
  if (CHAIN_MANAGER_CACHE.has(key)) {
    return CHAIN_MANAGER_CACHE.get(key)
  }
  const manager = await ChainMemoryManager.create(...)
  CHAIN_MANAGER_CACHE.set(key, manager)
  return manager
}
```

**教训**:

- 考虑对象生命周期
- 添加缓存防止重复创建
- 记得在 close() 时清理缓存

### 3. 测试阶段错误

#### ❌ 错误 3.1: 测试与实现脱节

```typescript
// test/integration.test.ts 引用了已删除的文件
import { AsyncWriteQueue } from "./async-queue"; // ❌ 文件已删除
```

**教训**:

- 删除文件时要更新所有引用
- 运行所有测试，不只是相关的
- 使用 TypeScript 检查 import

#### ❌ 错误 3.2: 依赖外部审查

```
等待 Codex bot 发现问题 → 修复 → 提交 → 等待下一次审查
```

**教训**:

- 主动测试，不要等外部审查
- 提交前自己跑集成测试
- 思考"我的修复会不会引入新问题"

### 4. 文档阶段错误

#### ❌ 错误 4.1: 文档与代码脱节

```markdown
<!-- 文档 -->

Chain Memory Backend supports async write with queue...

<!-- 代码 (6ebf88644) -->

// AsyncWriteQueue 已删除
// async write 功能完全移除
```

**教训**:

- 代码修改后立即更新文档
- 文档和代码同步提交
- 删除功能时也要更新文档

---

## 根本原因分析

### 为什么会出现"修复一个 bug，引入新 bug"？

1. **初始设计就是半成品**
   - 包含大量 placeholder
   - 功能设计脱离实际（async write）
   - 没有考虑真实使用场景

2. **缺少集成测试**
   - 只有单元测试，没有端到端测试
   - 没有测试完整的数据流
   - 测试覆盖率高，但都是孤立的

3. **"头痛医头"的修复方式**
   - 每次只修复表面问题
   - 没有深入分析根本原因
   - 没有重新审视整体设计

4. **依赖外部审查**
   - 等待 Codex bot 发现问题
   - 没有主动验证
   - 缺少自我审查

5. **文档和代码脱节**
   - 文档描述"理想状态"
   - 代码是"能跑就行"
   - 修改后不更新文档

### 为什么会这样？

1. **时间压力**
   - 想尽快完成功能
   - 跳过了设计和审查阶段
   - 匆忙提交

2. **过度自信**
   - 依赖 AI 生成的代码
   - 没有仔细审查
   - 假设"应该能工作"

3. **缺少验证**
   - 没有运行集成测试
   - 没有思考边界情况
   - 没有检查依赖关系

4. **没有学习**
   - 每次重复同样的错误
   - 没有总结教训
   - 没有改进流程

---

## 最佳实践

### 开发流程

1. **设计先行**
   - ✅ 先写设计文档
   - ✅ 明确接口定义
   - ✅ 考虑所有边界情况
   - ❌ 不要急于写代码

2. **增量开发**
   - ✅ 先实现核心功能
   - ✅ 确保每个功能都能工作
   - ✅ 逐步添加高级功能
   - ❌ 不要一次性提交所有功能

3. **测试驱动**
   - ✅ 先写集成测试
   - ✅ 测试完整的数据流
   - ✅ 测试边界情况
   - ❌ 不要只依赖单元测试

4. **代码审查**
   - ✅ 提交前自己审查
   - ✅ 运行所有测试
   - ✅ 检查文档一致性
   - ❌ 不要等外部审查

5. **持续改进**
   - ✅ 总结每个错误
   - ✅ 更新最佳实践
   - ✅ 改进开发流程
   - ❌ 不要重复犯同样的错误

### 代码规范

1. **不要提交 placeholder**

   ```typescript
   // ❌ 错误
   throw new Error("Not implemented");

   // ✅ 正确
   // 功能未实现，先不包含在提交中
   ```

2. **删除不能工作的代码**

   ```typescript
   // ❌ 错误
   // async function write() { ... }  // 注释掉

   // ✅ 正确
   // 完全删除，等接口支持时再添加
   ```

3. **保持一致性**

   ```typescript
   // ✅ 所有方法都遵循相同的模式
   async search() { /* fallback chain */ }
   async readFile() { /* fallback chain */ }
   async probe() { /* fallback chain */ }
   ```

4. **添加缓存防止泄漏**

   ```typescript
   // ✅ 使用缓存
   const CACHE = new Map();
   function get(key) {
     if (CACHE.has(key)) return CACHE.get(key);
     const value = create();
     CACHE.set(key, value);
     return value;
   }
   ```

5. **序列化复杂对象**

   ```typescript
   // ❌ 错误
   return { health: new Map() }; // JSON.stringify 返回 {}

   // ✅ 正确
   return { health: Object.fromEntries(map) };
   ```

### 测试规范

1. **必须有集成测试**

   ```typescript
   test("chain backend works end-to-end", async () => {
     const manager = await getMemorySearchManager({
       backend: "chain",
       chain: { primary: { backend: "builtin" } },
     });
     const result = await manager.search("test");
     expect(result).toBeDefined();
   });
   ```

2. **测试所有路径**
   - ✅ Primary 成功
   - ✅ Primary 失败 → Secondary 成功
   - ✅ Primary + Secondary 失败 → Fallback 成功
   - ✅ 全部失败

3. **运行所有测试**
   ```bash
   # ✅ 提交前运行所有测试
   npm test
   npm run test:integration
   ```

### 文档规范

1. **代码和文档同步**

   ```bash
   # ✅ 同一次提交包含代码和文档
   git add src/memory/chain/ docs/memory/
   git commit -m "feat: add X"
   ```

2. **更新 CHANGELOG**

   ```markdown
   ## Unreleased

   ### Breaking Changes

   - Removed AsyncWriteQueue (interface doesn't support writes)
   ```

3. **记录设计决策**
   ```markdown
   ### Why async factory pattern?

   - Need to initialize all providers
   - Some providers are async
   - Cannot use synchronous constructor
   ```

---

## 开发前必读

### ⚠️ 开始新功能前

1. **阅读本文档**
   - 了解项目历史
   - 了解犯过的错误
   - 了解最佳实践

2. **检查接口定义**

   ```typescript
   // 先检查 MemorySearchManager 有哪些方法
   interface MemorySearchManager {
     search(query): Promise<Result>;
     readFile(path): Promise<string | undefined>;
     // 有没有 add/update/delete?
   }
   ```

3. **写集成测试**

   ```typescript
   // 先写测试，再写实现
   test("new feature works", async () => {
     // ...
   });
   ```

4. **增量开发**
   - 先实现核心功能
   - 确保能工作
   - 再添加高级功能

### ⚠️ 提交前检查清单

- [ ] 所有测试通过（包括集成测试）
- [ ] TypeScript 编译无错误
- [ ] ESLint 无错误
- [ ] 文档已更新
- [ ] 没有提交 placeholder 代码
- [ ] 没有注释掉的代码
- [ ] 考虑了资源泄漏
- [ ] 考虑了边界情况
- [ ] 自己审查了代码

### ⚠️ 修复 bug 前

1. **理解根本原因**
   - 不要只修复表面问题
   - 找出为什么会发生
   - 思考是否需要重新设计

2. **检查影响范围**
   - 这个修复会不会破坏其他地方？
   - 需要同步修改什么？
   - 需要更新哪些测试？

3. **验证修复完整**
   - 修复是否覆盖所有情况？
   - 是否与其他代码一致？
   - 是否有类似的问题？

---

## 附录

### A. 当前代码状态

#### 已实现功能

- ✅ Multi-provider chain (Primary → Secondary → Fallback)
- ✅ Async factory pattern
- ✅ Manager cache
- ✅ Fallback logic for search/readFile/probe
- ✅ Circuit breaker
- ✅ Health monitor
- ✅ JSON-serializable health status
- ✅ Config validation
- ✅ TypeScript strict mode

#### 已移除功能

- ❌ AsyncWriteQueue (interface doesn't support writes)
- ❌ writeMode config option
- ❌ enableAsyncWrite config option

#### 待实现功能

- 🔜 Async write (when MemorySearchManager interface supports it)
- 🔜 Plugin provider support
- 🔜 Metrics and monitoring

### B. 关键文件清单

| 文件                | 作用              | 注意事项                |
| ------------------- | ----------------- | ----------------------- |
| `manager.ts`        | 核心逻辑          | 所有方法都要有 fallback |
| `search-manager.ts` | Factory + Cache   | 必须使用缓存            |
| `backend-config.ts` | Config resolution | 注意 timeout 配置       |
| `types.ts`          | 类型定义          | 保持与接口一致          |
| `wrapper.ts`        | Provider wrapper  | 处理 provider 差异      |

### C. 测试清单

| 测试文件                    | 覆盖范围 | 必须通过 |
| --------------------------- | -------- | -------- |
| `config-validation.test.ts` | 配置验证 | ✅       |
| `integration.test.ts`       | 集成测试 | ✅       |
| `e2e.test.ts`               | 端到端   | ✅       |
| `stress.test.ts`            | 压力测试 | ✅       |

---

## 结语

这个项目教会我们：

1. **不要急于写代码** - 设计先行
2. **不要相信 AI 生成的代码** - 自己审查
3. **不要只跑单元测试** - 集成测试更重要
4. **不要等外部审查** - 主动验证
5. **不要重复犯错误** - 总结教训

下次开发前，请先阅读本文档，避免重蹈覆辙。

---

_文档维护者: Tutu_
_最后更新: 2026-03-10_
_版本: 1.0_
