SheetMemory：结构化记忆协议规范 v1.1
这是 SheetMemory 的正式协议规范，定义 Schema、操作原语、确定性行为规则、硬性约束、架构角色以及分类器选择规范。涉及具体冷却时间、阈值、评分公式中权重选择、实验变体等工程细节，均移至独立的《实现者指南》，不阻塞协议本身的传播与引用。

一、设计原则
确定性优先，语义为辅助：检索以枚举字段过滤和检索友好键名为主引擎。语义搜索仅作为可选后处理。

LLM 为格式化输入器：LLM 负责将信息填入预定义 Schema，不自主决定记忆策略。

通用与可插拔：协议仅定义数据结构、操作原语和接口签名，不绑定存储后端、模型或编排框架。

二、数据模型
2.1 记忆项 Schema
字段 类型 必填 说明
id string 是 唯一标识，推荐 UUIDv7
type enum 是 entity / event / fact / rule / impression / plan / reflex
summary string 是 单句摘要，≤ 50 token
confidence float (0–1) 是 强制字段，未提供时按域默认值，全局回退 0.3
status enum 是 active / archived
timestamp ISO 8601 是 最后修改时间
links list of string (id) 是 关联记忆 ID，可为空数组
attributes map 否 结构化附加数据，使用下文保留键名
source object 推荐 来源描述，字段由实现定义
2.2 attributes 保留键名
以下为协议保留的键名语义。实现可以不全支持，但如果使用，必须遵守此处定义的类型和含义。

键名 类型 说明
salience float (0–1) 重要性，由 Perceptor 或等效模块计算
emotion string / list of string 关联情绪
trigger_tags list of string 确定性触发捷径
commitment bool 是否含时间承诺
contradiction_flag bool 是否与已有记忆矛盾
allow_coexistence bool 允许矛盾共存
domains list of string 多值域归属
people list of string 相关人员
locations list of string 相关地点
topics list of string 相关主题
critical bool 免疫自动衰减
activate_at ISO 8601 定时激活
expire_at ISO 8601 定时过期
fuzzy_ref string 元认知描述（置信度低时建议填充）
perceptor_uncertainty bool 感知信号不确定
tentative bool plan 专用，deadline 提取失败暂存
generated_by string 生成方式标识，压缩生成填 "compression"
consolidation_count int 被引用或纠正性重写次数
cross_domain_emotion bool 情绪跨域传播标记
last_user_access ISO 8601 用户最后一次主动访问该记忆的时间
followup_attempts int tentative 追问已尝试次数
last_followup_outcome string accepted / ignored / rejected
2.3 域默认置信度
域 默认 confidence 说明
personal 0.5 自我陈述较可信
work 0.3 含义推测
health 0.1 几乎只能来自用户明述
legal 0.1 或禁止写入 需用户显式确认
三、操作原语
3.1 QUERY
按字段过滤返回记忆摘要列表。过滤条件可组合，未指定的字段不作限制。

json
{
"action": "QUERY",
"filters": {
"type": ["event", "fact"],
"status": "active",
"confidence_min": 0.7,
"attributes": { "topics": "竞品分析" },
"text_contains": "关键词"
}
}
确定性行为：

必须支持按 type、status、confidence_min/confidence_max、时间范围、text_contains 以及 attributes 中的 people/locations/topics/domains 过滤。

结果集必须经确定性排序后截断至 ≤15 条（排序键选择由实现决定，推荐纳入 salience、confidence 和访问新鲜度）。

语义搜索仅可在候选集上做可选重排序，不得直接全量检索。

3.2 UPSERT
基于 id 或实现定义的幂等键创建或更新单条记忆。若记忆已存在，更新字段并保留未提供的原有字段。

json
{
"action": "UPSERT",
"entry": {
"type": "fact",
"summary": "用户生日 3 月 14 日",
"confidence": 0.95,
"domains": ["personal"]
}
}
确定性行为：

必须写入 id、type、summary、confidence、status、timestamp 和 source（如可获取）。

confidence 为必填，未提供时按域默认值，否则 0.3。

status 新记忆默认 active。

3.3 FORGET
软删除一条记忆，将其 status 设为 archived。

json
{
"action": "FORGET",
"id": "m4",
"reason": "auto-decay: score 0.12 (confidence 0.5, salience 0.3, 3 days inactive)"
}
确定性行为：

reason 字段必填。

若遗忘为纠正性遗忘（用户主动纠正），实现应同时清理与该记忆强关联的上下文引用（如对话历史摘要、活跃记忆缓存）。

若遗忘为自动衰减，reason 必须包含评分明细。

四、记忆生命周期与硬性约束
4.1 写入
LLM 生成记忆指令必须使用预定义 Schema。

实现必须对指令做结构修复（L1）。L1 修复范围包括：去除 Markdown 代码围栏（`json / `）、提取首段合法 JSON 对象、补全截断的尾括号。不可修复的指令丢弃并记录完整原始输出供调试，不得回退到 LLM 重试。

实现必须在写入前校验 type 字段值属于预定义枚举集（entity / event / fact / rule / impression / plan / reflex）。非法值（包括 LLM 自创类型）直接拒绝写入，记录原始输出，不得以模糊匹配或兜底类型静默替代。本约束不阻止实现为特定场景添加非规范扩展类型，但扩展类型必须使用明确的前缀命名空间以避免与协议未来版本冲突。

实现必须在写入前检测矛盾：若新记忆与已有 active 记忆在相同 type 下存在关键词重叠，设置 contradiction_flag = true；若允许共存，设置 allow_coexistence = true 并降低置信度至 min(原值, 0.5)。allow_coexistence 未设置或为 false 时，矛盾记忆不得在检索结果中同时以高置信度出现——实现应以较低 confidence 的副本标记为待审查或以模糊引用链接至主记忆。

4.2 检索
检索主引擎必须是字段过滤和键名匹配。语义搜索只能在经排序截断后的 ≤15 条候选集上执行。

当候选记忆的 generated_by = "compression" 时，实现可以对其 links 中的原始记忆执行结构化索引穿透（仅匹配 people/locations/topics），穿透深度由实现定义，但必须有上限并记录被截断的事件。

4.3 维护
实现可以执行周期性维护，包括：基于得分阈值的自动衰减归档、低频标签修剪、死链清理。

critical = true 的记忆不得被自动衰减。

expire_at 到期的记忆必须自动归档。

activate_at 未到的记忆在时效期内不得被衰减。

所有自动衰减操作必须记录完整评分明细。

4.4 纠正
用户主动 FORGET 视为最高优先级指令，必须立即执行，不得被规则否决。

实现应支持纠正性遗忘的关联上下文清理。

五、架构角色
角色 职责 约束
Perceptor 对话分析与信号提取，输出 type 推断和 importance 初值 纯规则，不调用 LLM
记忆网关 上下文拼装与指令路由 不调用 LLM
LLM 自然语言回复 + 格式化记忆指令 不自主决策记忆策略或 importance
执行器 校验、去重、写入、衰减 遵循协议规则

importance 的信源归属采用分层判定：

1. Perceptor 规则命中且置信度 ≥ 0.8 时，以 Perceptor 赋值为准，LLM 分类器不再覆写 importance。
2. Perceptor 未命中或置信度 < 0.8 时，由 LLM 分类器输出 importance，执行器对其做 [1, 10] 区间钳制。
3. 实现应在日志中记录每条记忆的 importance 来源（perceptor / llm / user），供运营者观测小模型 importance 退化。
   六、分类器选择规范
   分类器是将自然语言文本映射到预定义 Schema 的组件。分类器的可靠性和延迟直接影响记忆系统的端到端可用性，因此协议对分类器选型施加如下规范性约束。

6.1 模型选型原则

实现可以自由选择分类器模型，但必须遵守以下约束：

（1）禁止使用 thinking / reasoning 模型作为分类器。此类模型的内部推理链会消耗大量 token 预算（实测单条消息可达 200–500 token 的自我对话），导致输出 JSON 在写入 content 字段前被截断，且延迟不可接受（30 秒+/条）。分类任务不需要多步推理。

（2）temperature 必须设置为 0 或模型支持的最小值。非零温度会引入输出扰动，使相同输入产生不同的 type、importance 和 confidence 判断，破坏确定性原则。

（3）推荐使用 7B 参数级非思考模型作为分类器。实验数据表明：此级别模型在脏数据上的类型准确率约为 73%（中文），解析成功率为 93%，延迟约 2–3 秒/条。3B 级模型准确率下降至约 60%，且 importance 判别力显著退化（坍缩至二值）。1.5B 级及以下不建议使用。

（4）分类 prompt 必须显式强调：type 字段仅限协议定义的枚举值，不得自创类型。实现应在 prompt 中逐项列出合法值并附一个反例说明。

6.2 纯规则 fallback

实现必须提供纯规则分类路径作为 LLM 分类器的 fallback。以下信号可由规则直接判定，无需调用 LLM：

| 信号                                     | 判定类型                | 最低 confidence |
| ---------------------------------------- | ----------------------- | --------------- |
| 含"必须""禁止""不得""不允许"等约束词     | rule                    | 0.90            |
| 含"不喜欢""更倾向""最好用"等偏好词       | preference              | 0.85            |
| 含"不对""上次说的不对""不是X是Y"等纠正词 | 纠正标记 + 原 type 继承 | 0.90            |

纯规则路径确保 LLM 不可用时（本地模型崩溃、API 超限、网络中断）记忆系统仍能维持降级运行。

6.3 分类模型应支持本地部署

协议的"通用与可插拔"原则（参见第一节）要求记忆系统不被特定云服务绑定。实现应优先选择支持本地部署的分类模型（如通过 Ollama 加载的 qwen、llama 等系列），确保离线可用性和数据隐私。本地模型的具体版本和参数量由《实现者指南》推荐，不构成协议约束。

七、一致性边界
不规定：存储引擎选型、ID 生成算法、排序公式具体权重、冷却与上限的具体数值、穿透深度具体限制、是否及如何执行语义重排序、周期性维护的调度频率。

必须遵守：Schema 定义、操作原语的字段与行为契约、硬性约束（critical 免疫、expire_at 强制归档、activate_at 未到期保护、纠正性遗忘优先、type 枚举校验、分类器非思考模型约束等）、检索的确定性优先原则和截断上限、importance 分层信源归属。

协议规范到此结束。以下为《实现者指南》摘要，供实现时参考，不构成协议的规范性部分。
