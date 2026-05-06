# Strict Tool Mode 设计说明（OpenClaw 侧）

## 背景

OpenClaw 当前在工具调用链路上存在一层明显的“宽容兼容”逻辑，用于提高真实使用场景下的工具调用成功率。这类行为对日常使用是优点，但对训练和评测会引入一个结构性问题：模型即使没有严格遵守工具规格，也可能因为运行时自动修复而得到成功反馈。

本设计文档只讨论 **OpenClaw 运行时侧的 strict mode 设计**，不展开训练侧 reward / RL pipeline 设计。

## 我们已确认存在的宽容行为

### 1. 参数对象形态修复

在 `src/agents/transport-stream-shared.ts` 中，`coerceTransportToolCallArguments()` 会：

- 接受本来就是 object 的参数
- 若参数是 JSON string，则尝试 `JSON.parse()`
- parse 成功且结果为 object 时继续接受
- 否则回退为 `{}`

含义：模型即使没有输出标准对象形态的 tool arguments，也可能被系统自动修好。

### 2. 参数名 alias / 兼容字段

以 `read` 工具为例，在 `src/agents/pi-embedded-subscribe.handlers.tools.ts` 中会同时接受：

- `path`
- `file_path`

对应测试也明确验证了 `file_path` alias 会被接受。

### 3. tool name 归一化与兼容匹配

在 `src/agents/pi-embedded-runner/run/attempt.tool-call-normalization.ts` 中存在较强的工具名归一化逻辑，包括但不限于：

- 大小写宽容
- `functions.xxx` / `tools.xxx` 前缀兼容
- `/`、`.` 等分隔符混用时的候选推断
- 某些情况下从 tool_call_id 反推 tool name

### 4. transcript / block type 兼容

系统内部对一些 block type / tool call 表示也做了兼容，例如测试中接受：

- `toolCall`
- `tool_call`
- `toolUse`
- `functionCall`

## 问题定义

### 日常使用视角

宽容逻辑能：

- 提升工具调用成功率
- 降低因 provider 差异、模型轻微偏差导致的失败
- 提升真实交互的顺滑度

### 训练 / 评测视角

宽容逻辑会：

- 掩盖模型没有严格遵循 tool schema 的事实
- 让模型把“运行时帮忙修复”误学成可依赖能力
- 污染 tool-use fidelity 的评估信号
- 让训练后的模型在更严格环境中表现退化

因此，OpenClaw 需要一种 **strict mode**，用于在不破坏线上产品体验的前提下，为训练、回归测试、严格评测提供可控的“去宽容化”执行模式。

---

# 设计目标

## 目标

1. 保留默认模式下的产品宽容性
2. 提供可显式开启的 strict mode
3. strict mode 下尽量关闭会掩盖 schema 错误的自动修复
4. strict mode 的行为应可观测、可审计、可测试
5. strict mode 应尽量模块化，不把兼容逻辑散落成不可控分支

## 非目标

1. 不在本 PR 中设计 RL reward / 数据管线
2. 不要求一次性消灭所有历史兼容逻辑
3. 不要求默认运行模式切换为 strict

---

# 设计原则

## 原则 1：默认继续宽容，strict 明确开启

strict mode 应是显式 opt-in，而不是隐式影响现有产品行为。

## 原则 2：优先“拒绝并报清楚”，而不是静默修复

strict mode 的核心不是“更难用”，而是“更准确暴露模型错误”。

## 原则 3：将“修复点”变成可枚举策略位

不要只靠 scattered if/else。应把兼容行为抽象成若干可以统一开关的 repair policy。

## 原则 4：strict mode 先覆盖 tool-call fidelity 主路径

第一阶段优先覆盖：

- tool name
- arguments shape
- argument key alias
- transcript-level tool call normalization

---

# 建议设计

## 一、引入统一配置：Tool Strictness Mode

建议新增统一配置位，例如：

```json
{
  "agents": {
    "tools": {
      "strictMode": "off"
    }
  }
}
```

候选值建议：

- `off`：默认宽容模式
- `warn`：继续兼容，但记录 repair / alias / normalization 事件
- `strict`：禁用关键宽容逻辑，直接拒绝非 canonical 调用

如果希望更细粒度，也可最终落成：

- `off`
- `audit`
- `strict`

但第一版用 `off | warn | strict` 已够。

## 二、为兼容行为抽象 repair policy

建议把当前散落在多处的兼容逻辑归类成以下策略：

### 1. `toolNameNormalization`

控制是否允许：

- 大小写归一
- 前缀兼容（如 `functions.` / `tools.`）
- 分隔符兼容
- 从 tool_call_id 反推 tool name

### 2. `argumentShapeRepair`

控制是否允许：

- stringified JSON → object
- malformed args → `{}` 兜底

### 3. `argumentKeyAlias`

控制是否允许：

- `file_path` 兼容 `path`
- 其他 snake/camel/legacy alias

### 4. `toolCallBlockTypeCompatibility`

控制是否允许：

- `tool_call`
- `toolUse`
- `functionCall`
- 统一映射到 canonical tool call block

strict mode 下，这些策略应尽量关闭；warn mode 下保留执行但记录命中事件。

---

# 三、严格模式下的建议行为

## 1. Tool name 必须 canonical

strict mode 下：

- 不做模糊 tool name 匹配
- 只接受工具注册表中的 canonical name
- 遇到非 canonical name，直接返回结构化错误

错误示例：

- `unknown tool name in strict mode: functions.read`
- `tool name requires canonical form: expected read`

## 2. Arguments 必须是 object

strict mode 下：

- 不再对 stringified JSON 自动 parse 成 object
- 不再把非法参数静默回退为 `{}`
- 直接报：arguments shape invalid

## 3. 参数键必须 canonical

strict mode 下：

- `file_path` 不再等价于 `path`
- alias 字段存在时，直接报错并提示 canonical key

错误示例：

- `strict mode rejected alias key file_path; expected path`

## 4. Tool call block type 只接受 canonical 形式

strict mode 下：

- 不再接受非 canonical block 表示
- 回放/转译链也应标记不合法输入

---

# 四、warn / audit 模式

这是我认为特别有价值的一层。

在 `warn` 模式下：

- 保持当前执行成功率
- 但每次命中 repair/alias/normalization 时，记录结构化事件

例如记录：

```json
{
  "toolStrictness": {
    "mode": "warn",
    "repairs": [
      {
        "kind": "argumentKeyAlias",
        "tool": "read",
        "from": "file_path",
        "to": "path"
      }
    ]
  }
}
```

建议记录到：

- debug log
- cache trace（如果开启）
- tool execution metadata
- 可选的 session transcript metadata

这样后续无论训练、评估、数据筛选，都能基于运行时真实 repair 事件做分析。

---

# 五、推荐实现路径

## Phase 1：建立 strictness 配置与 instrumentation

本 PR 第一阶段建议先做：

- 新增统一 strict mode 配置
- 新增 repair event 结构
- 在现有宽容逻辑处统一打点
- 实现 `warn` 模式

这一步改动风险低，且能快速帮助后续分析。

## Phase 2：主路径 strict 化

然后逐步在关键路径落 strict 行为：

- tool name normalization
- arguments shape coercion
- alias key acceptance

## Phase 3：补齐测试与文档

需要新增：

- default mode 仍兼容的回归测试
- strict mode 下拒绝 alias / coercion 的测试
- warn mode 下 repair log 命中的测试

---

# 六、代码落点建议

## 1. `src/agents/transport-stream-shared.ts`

处理：

- `coerceTransportToolCallArguments()`

建议：

- 增加 strictness 参数
- 在 strict 下拒绝 string→object repair
- 在 warn 下记录 repair event

## 2. `src/agents/pi-embedded-runner/run/attempt.tool-call-normalization.ts`

处理：

- tool name normalization
- structured candidate inference
- tool_call_id 反推

建议：

- 将 normalization 策略显式受 strictness 控制
- strict 下只允许 exact canonical match

## 3. `src/agents/pi-embedded-subscribe.handlers.tools.ts`

处理：

- 读 `path` / `file_path`

建议：

- 把 alias 兼容抽成统一 helper
- strict 下拒绝 alias
- warn 下记录 alias hit

## 4. 统一新增一个 strictness helper 模块

建议新增例如：

- `src/agents/tool-strictness.ts`

统一负责：

- 读取 strict mode 配置
- 定义 repair kinds
- 统一生成 repair events
- 提供 `allowAlias / allowNormalization / allowRepair` 判断

这样能避免后续继续把 strictness 逻辑散在各处。

---

# 七、兼容性策略

## 默认行为不变

不显式开启 strict mode 时：

- 当前线上兼容行为保持不变

## strict mode 仅对明确环境生效

推荐优先用于：

- QA / parity / regression lane
- 训练专用 gateway/runtime
- 专门的 tool fidelity eval

而不是默认直接影响所有用户。

---

# 八、我建议本 PR 文档里明确写出的决策

1. **默认模式继续宽容**，不破坏产品成功率
2. **新增 strict mode** 用于显式关闭关键 tool-call repair
3. **新增 warn/audit 模式** 用于统计 repair 依赖而不影响执行
4. **本 PR 只做 OpenClaw 侧 strict mode 设计与实现准备**
5. **训练侧 reward / RL 策略不在本 PR 范围内**

---

# 九、建议在 PR 中重点回答的问题

## Q1. 为什么不直接删掉宽容逻辑？

因为线上真实使用依赖它，直接删除会明显降低可用性。

## Q2. 为什么 strict mode 有必要？

因为没有 strict mode，就无法把“模型真的严格遵循工具规格”和“运行时帮它擦屁股”区分开。

## Q3. 为什么需要 warn/audit mode？

因为 strict 一刀切太硬，先让系统能观测 repair 命中频率，有利于后续决定 strict 覆盖范围。

---

# 十、建议的后续实现顺序

1. 配置与 strictness helper 落地
2. `coerceTransportToolCallArguments()` 接 strictness
3. read/path alias 接 strictness
4. tool name normalization 接 strictness
5. 加 repair telemetry
6. 补回归测试和 strict 测试

---

# 附：当前已确认的典型宽容点（便于 PR 引用）

- `coerceTransportToolCallArguments()`：string JSON → object，非法值 → `{}`
- `read`：`path` / `file_path` 双接受
- tool name normalization：大小写、前缀、分隔符、部分推断
- tool call block 表示兼容：`toolCall` / `tool_call` / `toolUse` / `functionCall`

这足以支撑“OpenClaw 当前存在会影响训练 fidelity 的工具调用宽容层”这一结论。
