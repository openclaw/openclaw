# /loop 端到端测试场景

以下案例用于在本地环境运行 `/loop` 命令测试。**这些测试不会修改 loop 代码本身**，只验证 loop 系统在不同输入下的行为。

---

## 场景 1：简单任务（操作明确，范围清晰）

```
/loop 在 src/tui/README.md 中添加一行注释 "// TUI entry point" 然后验证它存在
```

**预期行为：**
- Analyze：找到文件位置，描述当前结构
- Plan：1 个子任务（串行）
- Execute：写入文件
- Verify：独立 agent session 读取文件确认行存在
- Report：输出包含添加的行
- 全程 ≤ 2 次 API 调用（analyze + execute/verify 合成一轮）

---

## 场景 2：复杂任务（多文件、有依赖、需要测试）

```
/loop 给 src/tui/tui-formatters.ts 中的 sanitizeRenderableText 函数添加 JSDoc 注释，
描述其参数和返回值类型；给对应的测试文件 src/tui/tui-formatters.test.ts 添加该函数的测试用例
--max-iterations 5
```

**预期行为：**
- Analyze：读取函数签名和测试文件现有结构
- Plan：2-4 个子任务（并行或串行取决于是否需要先读再写）
- Execute：修改源文件、添加测试
- Verify：运行 `pnpm test` 确认测试通过
- Report：列出修改的文件和新测试
- **验证重点**：是否有 test 覆盖率变化

---

## 场景 3：清晰目标（具体可验证的标准）

```
/loop 确保 src/tui/commands.ts 导出的 helpText 函数第一行输出包含
"/loop — Start an autonomous multi-phase loop"
如果不存在则添加；运行 pnpm test src/tui/commands.test.ts 验证通过
```

**预期行为：**
- Analyze：读取 helpText 内容
- Plan：1 个串行子任务
- Execute：检查存在性，添加缺失行
- Verify：验证字符串包含 + 测试通过
- **验证重点**：verify 阶段必须有 `grep` 或文件读取证据，不能只靠推理

---

## 场景 4：模糊目标（未明确验收标准，依赖 agent 解读）

```
/loop 让 README.md 看起来更专业
```

**预期行为：**
- Analyze：读取当前 README.md，指出改进点（标题结构、缺失章节、格式问题等）
- Plan：分析阶段的输出决定 Plan 的 subtasks。可能包括：
  - 添加目录（TOC）
  - 修复 markdown lint 问题
  - 添加徽章
- Execute：agent 自主决定改什么
- Verify：独立 agent 判断是否"更专业"
- **潜在问题**：验证标准主观，spawned verify 可能通过也可能失败
- **验证重点**：loop 不会因为标准模糊而崩溃；最终输出仍会被保存

---

## 场景 5：Token Budget 耗尽

```
/loop 在 src/tui/README.md 尾部追加 50 行 "// test line N\n" --budget 2
```

**预期行为：**
- Phase 1（analyze）执行：tokenUsage → 1（budget 2）
- Phase 2（plan）执行：tokenUsage → 2（budget 耗尽）
- Phase 3（execute）入口：`runPhase` line 732: `budgetLimit && currentUsage >= budgetLimit` 触发
  → 输出 `"⛔ Token budget (2) exceeded — stopping loop"`
  → `state.loopState = null`
  → 从 Phase 3 for 循环守卫 line 802-807 跳出
- **不会**浪费 token 发送 execute 消息
- **不会**执行 subtask 循环
- **验证重点**：
  - budget=N 很小时（< 5）正常停止
  - 不发出浪费的消息
  - clean up 路径执行（`setLoopState(null)`、`setCurrentSessionKey(undefined)`）

---

## 运行指引

```bash
# 1. 启动本地 gateway 并连接 TUI
pnpm dev

# 2. 在 TUI 中输入每条 /loop 命令
# 3. 观察 chat log 中的状态变化
# 4. 手动验证文件修改是否正确

# 也可编写自动化 e2e 测试（需 mock gateway）：
# node scripts/run-vitest.mjs run --config test/vitest/vitest.tui.config.ts src/tui/tui-command-handlers.test.ts
```

## 回归执行命令

```bash
# 验证所有 loop 相关测试
node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-tools.config.ts
node scripts/run-vitest.mjs run src/loop/loop-validation.test.ts --config test/vitest/vitest.unit.config.ts
node scripts/run-vitest.mjs run --config test/vitest/vitest.tui.config.ts src/tui/tui-command-handlers.test.ts
```
