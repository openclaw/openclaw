# web-control-ui 项目记忆与状态
- 定位：通过对话共创自定义前端页面的产品，不是普通控制台
- 核心方向：专属前端 agent、用户偏好记忆、对话驱动改代码、上游功能跟踪与推荐
- 当前版本：v0.2（主线已完成两层壳层 + 四种 usage-mode 初次整合）
- 状态：主工作区可直接切换 USE / CONTROL，并可验收 Native / Mission / Star / Blank 四种使用态
---
## 2026-03-15 核心产品定义（已收敛）
1. **输入单位 = 聊天**
   - 用户直接用自然语言提页面需求，不引入额外任务表单作为主入口
   - 系统负责把聊天需求转译成可执行的前端改动目标
2. **记忆单位 = 双层记忆**
   - 一层是 OpenClaw 原生会话/上下文能力
   - 一层是 `web-control-ui` 项目自己的长期项目记忆（独立维护，不只依赖聊天历史）
3. **输出单位 = 聊天 + 实际改代码/改页面**
   - 不是只给建议，而是通过 OpenClaw 原生链路实际修改代码、刷新页面、返回结果
4. **底座要求 = 强版本回退，优先保证不崩**
   - 版本回退不是附属功能，而是核心工作流
   - 默认工作流应尽量收敛为：需求 → checkpoint → 改代码 → build/验证 → 失败回退 / 成功保留
5. **因此当前主线不是做“普通控制台”**
   - 而是做一个以聊天为入口、以项目记忆为连续性、以真实代码修改为输出、以强回退能力兜底的前端共创工作台
6. **默认用户没有代码能力**
   - 产品默认面向非程序员使用，而不是默认面向会看 commit / ref / build log 的开发者
   - 这意味着版本回退、需求表达、结果反馈、错误提示都必须优先用自然语言与可点击操作表达，而不是把 Git / 构建细节直接甩给用户
7. **内部页面分为两层**
   - 第一层是“控制台层”：用户通过对话提出修改需求、查看版本状态、触发回退与继续迭代
   - 第二层是“常规使用层”：用户真正日常使用的页面/工作台本体
   - 控制台层服务于“改”，常规使用层服务于“用”；两者不能混成一个嘈杂界面
8. **默认采用“切换”而不是“并排”**
   - 默认先进入使用态，需要修改时再进入控制台态
9. **使用态先开发四个版本**
   - 一个“系统原生基线版”
   - 两个“参考 GitHub 项目思路的借鉴版”
   - 一个“偏空白/偏留白的起步版”
10. **四个使用态版本应当彼此独立**
   - 不是做成一个大杂烩页面再预装不同模块组合
   - 而是四个真正独立的页面本体/信息架构假设
   - 用户如果想要更多功能，应通过后续对话修改，把别的版本中的能力逐步集成进自己当前页面
11. **因此产品演进方式是“独立起点 + 用户自定义集成”**
   - 先给用户一个明确风格和结构的起点
   - 再通过控制台层持续把功能、模块、布局集成到当前页面
   - 不追求一开始就给一个超级全集合页面
12. **参考版 A 已明确：Mission Control 路线**（2026-03-15）
   - 参考目标：`robsannaa/openclaw-mission-control`
   - 不是机械复刻，而是借用其信息架构与“thin layer dashboard”思路，做成适配我们当前产品主线的一版
   - 关键借鉴点：左侧分组导航、路由化多视图、dashboard/chat/tasks/memory/usage/terminal 等工作台组织方式、控制台作为“总控层”而非单一聊天页
   - 必须保留我们自己的主线约束：聊天仍是改页面入口；项目记忆与偏好记忆继续存在；所有改代码动作继续走 OpenClaw 原生链路；版本回退仍是底座能力
   - Mission Control 这一版应优先被理解为“四个使用态版本”里的一个强结构参考起点，而不是把现有产品方向改回普通运维台
13. **参考版 B 已明确：Star Office 路线**（2026-03-15）
   - 参考目标：`ringhyacinth/Star-Office-UI`
   - 这条不是控制台总控思路，而是“把 AI 工作状态空间化 / 场景化 / 陪伴化”的使用态页面路线
   - 关键借鉴点：像素办公室世界观、角色状态可视化、昨日 memo、小队/访客 agent、低技术门槛浏览体验、把“谁在做什么”变成直观空间叙事
   - 这条路线特别适合作为“四个使用态版本”里的一个独立版本：偏空间感、偏氛围、偏陪伴式工作台，而不是表格/卡片/控制台密集堆叠
   - 必须注意其许可边界：代码可参考（MIT / 代码开源），但美术资源带非商用学习限制，不能默认照搬原像素素材；如果要走这条路线，应优先自制或替换资产
   - 这条路线与 Mission Control 构成互补：Mission Control 更像控制台层的强结构参考，Star Office 更像使用态本体的强感知参考
14. **ComfyUI-OpenClaw 的定位判断**（2026-03-15）
   - 参考目标：`rookiestar28/ComfyUI-OpenClaw`
   - 这不是和我们同类的“前端共创页面产品”，而是一个**面向 ComfyUI 的 security-first orchestration layer**：把 ComfyUI 变成可自动化、可远程管理、可接多平台消息入口的 AIGC 工厂控制层
   - 它的核心是：嵌入 ComfyUI 进程的扩展 UI + 独立远程管理台 + 安全加固的 API / webhook / approvals / schedules / presets / model manager / connector
   - 与我们项目相同点：都不是单纯聊天页；都有“内嵌控制面 + 独立管理面”的分层意识；都重视安全边界与可靠操作
   - 与我们项目根本差异：它的对象是 **ComfyUI 工作流/模型/自动化运维**，而我们的对象是 **通过对话持续共创用户自己的前端页面**；它偏运维/编排/节点/接口治理，我们偏页面产品、偏好记忆、改代码闭环、非程序员可用性与版本回退
   - 对我们的启发主要在“分层架构”和“高风险能力外置”，而不是直接照搬其功能集合；不能因为它功能很多就把我们的产品重新做回一个大杂烩控制台
---
## 已完成功能
1. **前端提示词工作台**
   - 核心模块：src/product/prompt.ts
   - 自动拼接用户偏好+当前需求+安全约束
2. **偏好记忆**
   - 核心模块：src/product/storage.ts
   - 本地存储用户布局/风格/交互习惯
3. **原生改代码链路**
   - 基于 OpenClaw 原生 chat.send
   - 安全模式默认开启：改前 checkpoint → 改代码 → build 验证 → 失败回退
4. **版本回退机制**
   - 三个配套脚本：
     - scripts/web-control-ui-checkpoint.ps1
     - scripts/web-control-ui-restore.ps1
     - scripts/web-control-ui-list-checkpoints.ps1
   - UI 已集成快捷操作入口
5. **token 自动接入**
   - 核心模块：src/product/auth.ts
   - 支持官方 #token=... 路径自动登录
6. **可用性优化**
   - 长消息折叠
   - 消息分类显示：reply/status/build/command
   - 视图切换：全部/回复/操作日志
7. **两层壳层 + 四种 usage-mode 主线整合**（2026-03-15 16:20-16:29）
   - 已把 Claude Code 产出的三条并行工位成果收口进主工作区：
     - `cc-shell-split` → USE / CONTROL 两层壳层
     - `cc-usage-native-blank` → Native / Blank
     - `cc-usage-mission-star` → Mission / Star
   - 当前主线已支持：顶部切换 USE / CONTROL，侧边切换 Native / Mission / Star / Blank
   - 已实际验证：主工作区 `node ./node_modules/vite/bin/vite.js build` 通过；浏览器中可见 Native 与 Mission 视图正常切换
---
## 项目文件结构
```
openclaw-src/apps/web-control-ui/
├── index.html
├── package.json
├── vite.config.ts
├── src/
│   ├── main.ts          # 主入口
│   ├── styles.css       # 样式
│   └── product/
│       ├── agent-contract.ts  # 早期协议沉淀
│       ├── auth.ts            # 认证模块
│       ├── defaults.ts        # 默认配置
│       ├── prompt.ts          # 提示词模块
│       └── storage.ts         # 存储模块
└── dist/              # 构建产物
```
---
## 开发模式
- dev 服务地址：http://localhost:4173/
- 热重载已开启
- 构建命令：node ./node_modules/vite/bin/vite.js build
---
## 长期记忆（我该怎么做事）
1. 先调查，后发言
2. 多步任务边做边记：记录动作/结果/状态/下一步
3. 回答进度优先依据当场记录，不凭回忆拼接
4. 重视后台劳动和隐藏代价，不唯效率论
5. 自动化任务一次性挂好，不反复打扰用户
---
## 下一步推进方向
1. checkpoint 历史可视化
2. 操作日志细分面板
3. 提示词与偏好记忆的 UI 配置
4. OpenClaw 上游新功能跟踪推荐
---
## 强版本回退系统拆解（2026-03-15）
### 一、用户视角必须有的能力
1. **改前可留点**：用户能明确知道本轮改动前有没有 checkpoint
2. **最近版本可见**：能直接看到最近 checkpoint 列表，而不是只看 hash
3. **一键回退**：能从 UI 直接恢复到某个 checkpoint
4. **回退后有验证**：恢复后自动 build / 基本复核，不让用户猜是否恢复成功
5. **失败时有保底**：当本轮改坏、build 失败或页面明显跑偏时，系统应明确提示恢复路径

### 二、agent 执行规则
1. 默认把版本回退视为工作流的一部分，而不是事故后的补救
2. 中高风险改动前默认先建 checkpoint
3. 改动后默认做 build / 验证
4. 若 build 失败，优先提示或执行恢复到最近安全 checkpoint
5. 所有 checkpoint / restore / verify 动作都应通过 OpenClaw 原生链路触发并把结果回显给聊天

### 三、系统自动策略
1. **safe mode 默认开启**：高风险改动自动要求先 checkpoint
2. **失败即报警**：build 失败、恢复失败、找不到 ref 时要清晰暴露状态
3. **恢复后再校验**：restore 不是终点，restore + verify 才算闭环
4. **减少手工输入**：优先从“最近 checkpoint 列表”选择，而不是让用户手输 ref

### 四、UI 最小露出入口
1. Rollback First 面板常驻
2. 创建 checkpoint
3. 查看最近 checkpoint
4. 输入 / 选择 ref 后恢复
5. 显示最近一次 build / restore 状态
6. 后续可补：checkpoint 历史时间线、按需求轮次展示版本点

### 五、分期理解
- **P0**：checkpoint / list / restore / restore 后 verify（先保证不崩）
- **P1**：checkpoint 历史可视化、按需求轮次命名、失败时更明确的自动恢复建议
- **P2**：更智能的风险分级与自动回退策略
---
## 并行维护内容
### marxism-self-positioning 会话归档
- 状态：✅ 正常运行中
- 巡检频率：每5分钟
- 保留内容：raw transcript、readable dialogue、article 副本、session summary
- 最新状态：complete，无缺件、无污染
- Source: memory/2026-03-15.md