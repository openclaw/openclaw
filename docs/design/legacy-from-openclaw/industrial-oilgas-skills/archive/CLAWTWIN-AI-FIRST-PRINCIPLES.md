# ClawTwin AI 优先设计准则（AI-First Principles）

> **版本**：v1.0 · 2026-05-13
> **性质**：让 AI 真正帮到人的工程化判断准则
> **关系**：与 `CLAWTWIN-PHYSICS-FOUNDATIONS.md`（科学基础）和 `CLAWTWIN-PHILOSOPHY-CRITIQUE.md`（哲学评估）并列。

---

## 一、为什么需要这份准则

前置工作建好了知识飞轮的所有基础设施（数据写入、OutcomeEvent 采集、人工标注、训练数据导出）。但批判性自审暴露了一个真实问题：

> **AI 能学习了，但还不能帮人。**

工程师打开设备详情页时，他真正关心的不是健康分 73%、ΔHealth -2.1%、blast_radius 4。他关心的是：**"现在我应该做什么？"**

这份文档定义了让 AI 真正帮到人需要遵守的五条准则。

---

## 二、AI 优先准则（5 条）

### 准则 1：AI 输出"行动建议"，不是"数据指标"

❌ 反例：AI 在仪表盘上显示一堆指标（健康分、新鲜度、覆盖率）。
✅ 正例：AI 在显眼位置告诉用户"建议执行：清理过滤器（85% 置信度，过去 12 次成功）"。

**判断标准**：用户看到 AI 输出后，能否立刻进入下一个动作？如果还要思考"这数据意味着什么"，那是数据展示，不是 AI 帮助。

实现：`/v1/equipment/{id}/recommended-actions` + `AIRecommendationCard` 组件。

---

### 准则 2：每条 AI 建议都必须可审计

❌ 反例：AI 说"建议清洗轴承"，但用户不知道为什么。
✅ 正例：AI 说"建议清洗轴承（基于 12 个相似历史案例，9 个成功，3 个由工程师人工核实，最近一次：2026-04-28）"。

**判断标准**：用户问"凭什么"时，AI 能给出具体的过去案例 ID 和数据依据。

实现：`Recommendation.evidence` 字段必填，包含 `sample_outcome_ids`、`recovered_cases`、`human_labeled_cases`、`most_recent_at`。Rationale 文本由代码生成，不可凭空编造。

---

### 准则 3：AI 自主性必须分级，不能一刀切

❌ 反例：AI 高置信度时直接执行，低置信度时不显示。
✅ 正例：AI 按置信度分四档：

- ≥ 0.80 `auto_execute`（未来能力，需 OperationalEnvelope 守卫）
- ≥ 0.50 `hitl_required`（人审批后执行）
- ≥ 0.20 `display_only`（仅参考，不创建工单）
- < 0.20 `no_recommendation`（不展示，避免误导）

**判断标准**：每条 AI 建议必须明确标注"现在该怎么处理我"。

实现：`recommendation_engine._autonomy_level()` 函数 + UI Tag 分色。

---

### 准则 4：AI 失败必须可见

❌ 反例：AI 推荐失败后，没有任何反馈，下次还会犯同样错。
✅ 正例：AI 推荐过的工单完成后，OutcomeEvent 自动测量结果。`degraded` 案例自动降低相似建议的 confidence，且工程师可在 OutcomeEvents 页过滤查看 AI 之前推荐失败的案例。

**判断标准**：当用户问"AI 上次推荐错了的案例在哪？"，UI 能在 30 秒内给出答案。

实现：

- OutcomeEvent.outcome_type='degraded' 自然降权后续相似推荐
- Studio `/outcomes?outcome_type=degraded&evaluated_by=human` 一键过滤反例

---

### 准则 5：用户的每一次标注都让 AI 变好

❌ 反例：工程师标注了"实际是轴承磨损"，但下次 AI 还是推荐"清洗"。
✅ 正例：工程师标注后 `evaluated_by='human'`，下次推荐引擎会给这类样本 +0.20 置信度（高质量训练标签权重）。

**判断标准**：人工标注必须被 AI 立刻使用，不是堆在数据库里等"未来"。

实现：`recommendation_engine._compute_confidence()` 中 `W_HUMAN_LABEL = 0.20`，`evidence.human_labeled_cases` 直接进入 confidence 公式。

---

## 三、知识飞轮在这五条准则下的运作

```
              ① 设备详情页：AI 看到设备 → 检索历史 OutcomeEvent
                              ↓
              ② AI 给出 Top-3 推荐（含证据 + 置信度 + 自主性等级）
                              ↓
              ③ 工程师"按此创建工单"（一键，预填字段）
                              ↓
              ④ 工单进入 HITL 审批（confidence ≥ 0.5 时）或直接 done
                              ↓
              ⑤ 90 分钟后 OutcomeEvent 收集器测量 ΔHealth → recovered/degraded
                              ↓
              ⑥ 工程师在 OC 页查看结果 → 标注实际原因（evaluated_by='human'）
                              ↓
              ⑦ 下一次相似设备类似情况 → AI 利用最新 evidence 给出更准推荐
                              ↺
```

每个环节在系统中都有真实的 HTTP 端点和 UI 组件支撑，不是 PPT 流程图。

---

## 四、避免过度设计的两条戒律

### 戒律 A：不要在 OutcomeEvent 之外再造一个 ai_reflections 表

`OutcomeEvent.outcome_type='degraded' AND evaluated_by='human'` 已经是最完整的"AI 失败案例"记录。再造一个 `ai_reflections` 表会：

- 数据冗余（同一事件存两次）
- 维护成本（需要同步两表）
- 没有新信息（不增加任何 OutcomeEvent 没有的字段）

只有当出现以下情况之一才考虑：

- 需要记录 AI 当时输出的具体置信度（用于评估 calibration）
- 需要记录用户当时是否采纳了 AI 推荐（采纳率指标）

这两个需求出现时，加字段到 OutcomeEvent，不建新表。

### 戒律 B：不要让 AI 推荐"看起来像神谕"

每条推荐必须满足：

- `evidence.similar_cases_total >= 1`（不能从虚空生成建议）
- `rationale` 是基于 evidence 生成的事实陈述（不能 LLM 自由发挥编理由）
- `confidence < 0.2` 时直接不返回（不展示比展示更负责任）

LLM 可以润色 rationale 文本，但不能创造 evidence 中没有的事实。

---

## 五、判断"是否符合 AI-First"的清单

新增 AI 功能前，逐项核对：

- [ ] 这个功能输出的是"行动"还是"数据"？（准则 1）
- [ ] 用户能问"凭什么"并得到具体证据吗？（准则 2）
- [ ] 自主性分级是否清晰？（准则 3）
- [ ] AI 在这里失败时，失败可见吗？（准则 4）
- [ ] 用户标注会立刻改进这个功能吗？（准则 5）

任一答案是"否"，先停下来重新设计。

---

## 六、当前实现达成的检查清单

| 准则          | 实现位置                                                   | 状态 |
| ------------- | ---------------------------------------------------------- | ---- |
| 1. 行动建议   | `AIRecommendationCard` 显示"按此创建工单"按钮              | ✅   |
| 2. 可审计     | `Recommendation.evidence + rationale + sample_outcome_ids` | ✅   |
| 3. 自主性分级 | `_autonomy_level()` 四档 + UI 颜色标识                     | ✅   |
| 4. 失败可见   | OutcomeEvents 页过滤 + 推荐引擎自动降权                    | ✅   |
| 5. 标注改进   | `W_HUMAN_LABEL = 0.20` 直接进入 confidence                 | ✅   |

**结论**：当前实现是符合 AI-First 准则的最小完整闭环。下一步（Phase B）的工作不是增加新概念，而是用真实数据让飞轮实际转起来。

---

_这份文档不会经常修改。它定义的是 ClawTwin 的 AI 工程哲学，而不是临时实现细节。任何打破这五条准则的设计，必须有书面理由。_
