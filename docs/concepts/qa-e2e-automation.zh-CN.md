---
summary: "qa-lab、qa-channel、种子场景和协议报告的私有 QA 自动化形态"
read_when:
  - 扩展 qa-lab 或 qa-channel
  - 添加基于仓库的 QA 场景
  - 围绕网关仪表板构建更高真实度的 QA 自动化
title: "QA 端到端自动化"
---

# QA 端到端自动化

私有 QA 栈旨在以比单个单元测试更真实、更通道化的方式测试 OpenClaw。

当前组件：

- `extensions/qa-channel`：合成消息通道，具有 DM、通道、线程、反应、编辑和删除表面。
- `extensions/qa-lab`：调试器 UI 和 QA 总线，用于观察记录、注入入站消息和导出 Markdown 报告。
- `qa/`：用于启动任务和基线 QA 场景的基于仓库的种子资产。

当前 QA 操作员流程是一个双窗格 QA 站点：

- 左侧：带有代理的网关仪表板（控制 UI）。
- 右侧：QA 实验室，显示类似 Slack 的记录和场景计划。

运行它：

```bash
pnpm qa:lab:up
```

这会构建 QA 站点，启动基于 Docker 的网关通道，并暴露 QA 实验室页面，操作员或自动化循环可以在其中为代理提供 QA 任务，观察真实的通道行为，并记录哪些成功、失败或保持阻塞。

为了在不每次重建 Docker 镜像的情况下更快地进行 QA 实验室 UI 迭代，使用绑定挂载的 QA 实验室捆绑包启动栈：

```bash
pnpm openclaw qa docker-build-image
pnpm qa:lab:build
pnpm qa:lab:up:fast
pnpm qa:lab:watch
```

`qa:lab:up:fast` 将 Docker 服务保持在预构建的镜像上，并将 `extensions/qa-lab/web/dist` 绑定挂载到 `qa-lab` 容器中。`qa:lab:watch` 在更改时重建该捆绑包，当 QA 实验室资产哈希更改时，浏览器会自动重新加载。

对于传输真实的 Matrix 烟雾通道，运行：

```bash
pnpm openclaw qa matrix
```

该通道在 Docker 中配置一个一次性的 Tuwunel 家庭服务器，注册临时驱动程序、SUT 和观察者用户，创建一个私人房间，然后在 QA 网关子进程中运行真实的 Matrix 插件。实时传输通道保持子配置范围为正在测试的传输，因此 Matrix 在子配置中不使用 `qa-channel` 运行。它将结构化报告工件和组合的 stdout/stderr 日志写入选定的 Matrix QA 输出目录。要同时捕获外部 `scripts/run-node.mjs` 构建/启动器输出，请将 `OPENCLAW_RUN_NODE_OUTPUT_LOG=<path>` 设置为仓库本地日志文件。

对于传输真实的 Telegram 烟雾通道，运行：

```bash
pnpm openclaw qa telegram
```

该通道针对一个真实的私人 Telegram 群组，而不是配置一次性服务器。它需要 `OPENCLAW_QA_TELEGRAM_GROUP_ID`、`OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN` 和 `OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN`，以及同一私人群组中的两个不同机器人。SUT 机器人必须有 Telegram 用户名，当两个机器人都在 `@BotFather` 中启用了机器人到机器人通信模式时，机器人到机器人观察效果最佳。

实时传输通道现在共享一个更小的契约，而不是各自发明自己的场景列表形状：

`qa-channel` 仍然是广泛的合成产品行为套件，不是实时传输覆盖矩阵的一部分。

| 通道     | 金丝雀 | 提及门控 | 允许列表阻止 | 顶级回复 | 重启恢复 | 线程跟进 | 线程隔离 | 反应观察 | 帮助命令 |
| -------- | ------ | -------- | ------------ | -------- | -------- | -------- | -------- | -------- | -------- |
| Matrix   | x      | x        | x            | x        | x        | x        | x        | x        |          |
| Telegram | x      |          |              |          |          |          |          |          | x        |

这保持 `qa-channel` 作为广泛的产品行为套件，而 Matrix、Telegram 和未来的实时传输共享一个明确的传输契约清单。

对于在 QA 路径中不引入 Docker 的一次性 Linux VM 通道，运行：

```bash
pnpm openclaw qa suite --runner multipass --scenario channel-chat-baseline
```

这会启动一个全新的 Multipass 来宾，安装依赖项，在来宾内部构建 OpenClaw，运行 `qa suite`，然后将正常的 QA 报告和摘要复制回主机上的 `.artifacts/qa-e2e/...`。它重用与主机上 `qa suite` 相同的场景选择行为。主机和 Multipass 套件运行默认情况下使用隔离的网关工作器并行执行多个选定的场景，最多 64 个工作器或选定的场景计数。使用 `--concurrency <count>` 调整工作器计数，或使用 `--concurrency 1` 进行串行执行。实时运行转发对来宾实用的支持的 QA 身份验证输入：基于环境的提供者密钥、QA 实时提供者配置路径，以及存在时的 `CODEX_HOME`。将 `--output-dir` 保持在仓库根目录下，以便来宾可以通过挂载的工作区写回。

## 基于仓库的种子

种子资产位于 `qa/` 中：

- `qa/scenarios/index.md`
- `qa/scenarios/<theme>/*.md`

这些故意放在 git 中，以便 QA 计划对人类和代理都可见。

`qa-lab` 应该保持为通用的 Markdown 运行器。每个场景 Markdown 文件是一个测试运行的真实来源，应该定义：

- 场景元数据
- 可选的类别、能力、通道和风险元数据
- 文档和代码引用
- 可选的插件要求
- 可选的网关配置补丁
- 可执行的 `qa-flow`

支持 `qa-flow` 的可重用运行时表面允许保持通用和交叉切割。例如，Markdown 场景可以结合传输端助手和浏览器端助手，通过网关 `browser.request` 接缝驱动嵌入式控制 UI，而无需添加特殊情况运行器。

场景文件应按产品能力而不是源树文件夹分组。文件移动时保持场景 ID 稳定；使用 `docsRefs` 和 `codeRefs` 进行实现可追溯性。

基线列表应足够广泛，以涵盖：

- DM 和通道聊天
- 线程行为
- 消息操作生命周期
- cron 回调
- 记忆回忆
- 模型切换
- 子代理交接
- 仓库阅读和文档阅读
- 一个小的构建任务，如 Lobster Invaders

## 提供者模拟通道

`qa suite` 有两个本地提供者模拟通道：

- `mock-openai` 是场景感知的 OpenClaw 模拟。它仍然是基于仓库的 QA 和奇偶性门的默认确定性模拟通道。
- `aimock` 启动一个基于 AIMock 的提供者服务器，用于实验性协议、夹具、记录/重放和混沌覆盖。它是附加的，不会替换 `mock-openai` 场景调度器。

提供者通道实现位于 `extensions/qa-lab/src/providers/` 下。每个提供者拥有其默认值、本地服务器启动、网关模型配置、身份验证配置文件暂存需求以及实时/模拟能力标志。共享套件和网关代码应通过提供者注册表路由，而不是基于提供者名称分支。

## 传输适配器

`qa-lab` 拥有 Markdown QA 场景的通用传输接缝。`qa-channel` 是该接缝上的第一个适配器，但设计目标更广泛：未来的真实或合成通道应该插入同一个套件运行器，而不是添加特定于传输的 QA 运行器。

在架构层面，分割是：

- `qa-lab` 拥有通用场景执行、工作器并发、工件写入和报告。
- 传输适配器拥有网关配置、就绪状态、入站和出站观察、传输操作和标准化传输状态。
- `qa/scenarios/` 下的 Markdown 场景文件定义测试运行；`qa-lab` 提供执行它们的可重用运行时表面。

面向维护者的新通道适配器采用指南位于 [测试](/help/testing#adding-a-channel-to-qa)。

## 报告

`qa-lab` 从观察到的总线时间线导出 Markdown 协议报告。报告应回答：

- 什么工作了
- 什么失败了
- 什么保持阻塞
- 什么后续场景值得添加

对于字符和风格检查，在多个实时模型引用上运行相同的场景并编写判断的 Markdown 报告：

```bash
pnpm openclaw qa character-eval \
  --model openai/gpt-5.4,thinking=xhigh \
  --model openai/gpt-5.2,thinking=xhigh \
  --model openai/gpt-5,thinking=xhigh \
  --model anthropic/claude-opus-4-6,thinking=high \
  --model anthropic/claude-sonnet-4-6,thinking=high \
  --model zai/glm-5.1,thinking=high \
  --model moonshot/kimi-k2.5,thinking=high \
  --model google/gemini-3.1-pro-preview,thinking=high \
  --judge-model openai/gpt-5.4,thinking=xhigh,fast \
  --judge-model anthropic/claude-opus-4-6,thinking=high \
  --blind-judge-models \
  --concurrency 16 \
  --judge-concurrency 16
```

该命令运行本地 QA 网关子进程，而不是 Docker。字符评估场景应通过 `SOUL.md` 设置角色，然后运行普通用户回合，如聊天、工作区帮助和小文件任务。候选模型不应被告知正在接受评估。该命令保留每个完整记录，记录基本运行统计信息，然后要求法官模型在快速模式下以 `xhigh` 推理按自然度、氛围和幽默对运行进行排名。当比较提供者时使用 `--blind-judge-models`：法官提示仍然获取每个记录和运行状态，但候选引用被替换为中性标签，如 `candidate-01`；报告在解析后将排名映射回真实引用。候选运行默认为 `high` 思考，支持它的 OpenAI 模型为 `xhigh`。使用 `--model provider/model,thinking=<level>` 内联覆盖特定候选。`--thinking <level>` 仍然设置全局回退，旧的 `--model-thinking <provider/model=level>` 形式为兼容性保留。OpenAI 候选引用默认为快速模式，因此在提供者支持的地方使用优先级处理。当单个候选或法官需要覆盖时，内联添加 `,fast`、`,no-fast` 或 `,fast=false`。仅当您想强制为每个候选模型启用快速模式时，才传递 `--fast`。候选和法官持续时间记录在报告中用于基准分析，但法官提示明确表示不要按速度排名。候选和法官模型运行默认并发为 16。当提供者限制或本地网关压力使运行过于嘈杂时，降低 `--concurrency` 或 `--judge-concurrency`。当未传递候选 `--model` 时，字符评估默认为 `openai/gpt-5.4`、`openai/gpt-5.2`、`openai/gpt-5`、`anthropic/claude-opus-4-6`、`anthropic/claude-sonnet-4-6`、`zai/glm-5.1`、`moonshot/kimi-k2.5` 和 `google/gemini-3.1-pro-preview`。当未传递 `--judge-model` 时，法官默认为 `openai/gpt-5.4,thinking=xhigh,fast` 和 `anthropic/claude-opus-4-6,thinking=high`。

## 相关文档

- [测试](/help/testing)
- [QA 通道](/channels/qa-channel)
- [仪表板](/web/dashboard)
