# 计划 — 观舆龙虾「创建侵权研判任务 + 查询任务数据」

> 目标（用户最终拍板 2026-06-15）：OpenClaw agent（昵称「观舆龙虾」）与 PHP 后端 `leading-v2.0` 深度对接，达到 **① 能创建（侵权研判）任务 + ② 能查询相关任务数据**。
> **不做 Phase 2（不接管 Java worker）。** 「创建任务」= agent 作为客户端建案 + 加链接 + 投递现有 Java 队列（`TaskWorker`），Java 照常研判，agent 再回查结果。

新建扩展 `extensions/infringement`，注册两个工具：

- `infringement_query`（读）— 查案件/链接/研判结果/账号画像/KPI
- `infringement_create_task`（写）— 建案 + 加链接 + 派发研判

---

## 1. 源码真值（已核实）

**模块**：`InfringementController`（分析 `url/miniprogram/videochannel` 链接违规）= 图文/视频侵权检测。库 `superworker`（与 feed 同库）。

**写入契约**（`analyzeAction`/`bulkUploadAction`）：

- 建案 `infringement_case`：必填 `{ case_no, uid, groupId, status:1, created_at, updated_at }`，可选 `reporter, enterprise_type, target`。
  - `case_no = 'WXB-' + 年 + '-' + 4位随机(1..9999)`（`random_int`，**非唯一 → 冲突重试**）。
- 加链接 `infringement_link.bulkInsert`：每行 `{ case_id, url, title, platform=detectPlatform(url), account, analyze_status:'pending', score:-1, status:1, created_at, updated_at }`。
- 标记研判 `markAnalyzing`：`{ stage:'analyzing', link_count, analyze_mode:(linkCount>=2?'cluster':'single'), progress:0, updated_at }`。
- 派发：`sendToQueue('TaskWorker', String(caseId), {persistent:true})`（默认 exchange，routing key = 队列名）。
- 时间戳 = **unix 秒**（PHP `time()`）。
- 全程事务：建案 + 加链接 + markAnalyzing 提交后再派发 MQ。

**陷阱**：`entity_auth.entityId`(Legal) 指向旧 `LegalCheckJob`，**非** `infringement_case` → entity_auth 只作访问门、不作 join 键。`genCaseNo` 随机非唯一。`detectPlatform` 仅简单域名匹配。

---

## 2. 权限边界（服务端强制，绝不信 LLM 参数）

工厂层（`ctx.agentId` 可信身份）：

1. `agentId` 须匹配 `^rabbitmq-(.+)$` → `userId`，否则工具隐藏（`null`）。
2. **Legal 访问门**：`SELECT 1 FROM entity_auth WHERE uid=? AND entityType='Legal' LIMIT 1` 非空才放行；空则隐藏工具。5min 缓存 + DB 抖动降级。
3. 读工具：默认 `secret=0`，仅 `legal_user_role.su=1` 超级用户可见 `secret=1`。
4. 写工具：新建案件 `uid = <当前 userId>`、`groupId` 查 `legal_user_role`（无则 0）。

---

## 3. `infringement_query`（读，4 mode）

参数化 SQL + 投影白名单 + PII 脱敏。

- `cases`：筛选案件列表。入参 `stage? / accept_conclusion? / archived? / min_score? / startDate? / endDate? / keyword? / limit(1-50,默认20)`。返回 `id, case_no, reporter, enterprise_type, target, stage, accept_conclusion, analyze_mode, overall_score, progress, link_count, handler, created_at, updated_at`（**无 PII**）。
- `case_detail`：单案全景。入参 `caseId`。案件行（phone/email **脱敏**）+ 链接列表 + 报告摘要（不裸吐 report_json）。
- `account`：账号违规画像。入参 `account, platform?`。聚合总数/达标违规数(score≥6)/评分分布/平台分布/关联 caseId。
- `kpi`：`pending(handler='' AND stage∈draft,accepted) / processing(archived=0 AND stage∈analyzing,analyzed) / done(archived=1)`。

## 4. `infringement_create_task`（写）

入参：`links`（必填，url 数组或多行文本，≥1）、`reporter?`、`target?`、`enterpriseType?`。
流程（单事务，照搬 analyzeAction）：建案 → bulkInsert 链接 → markAnalyzing → 提交 → `sendToQueue('TaskWorker', caseId)`。
返回：`{ caseId, caseNo, mode, linkCount, topic:'infringement/'+caseId }`。

---

## 5. 文件清单（`extensions/infringement/`）

`package.json` · `openclaw.plugin.json`(configSchema: `mysql` 读 + `writerDb` 写 + `rabbitmq`) · `api.ts` · `index.ts`(注册两工具 + service 生命周期) · `src/`：`types.ts` `mysql-client.ts`(读/写池) `legal-auth-resolver.ts` `infringement-fields.ts`(白名单/脱敏/enum) `infringement-query-builder.ts` `infringement-query-tool.ts` `detect-platform.ts` `case-writer.ts` `rabbitmq-publisher.ts` `infringement-create-tool.ts` + 各 `*.test.ts`。

**注册范式照搬 feed_query**（扩展工具 `api.registerTool`，**无需** tool-catalog 登记——434 教训仅针对核心工具）。

## 6. 测试（≥80%）

工厂门控（Legal/非 Legal/非 rabbitmq agent）、su=1 保密案分支、SQL builder 参数绑定/白名单/脱敏、4 个读 mode、写工具事务（建案+链接+markAnalyzing+派发，case_no 冲突重试）、detectPlatform。

## 7. 验证

`pnpm check` + `pnpm build`，给出重启网关 + 端到端冒烟清单（含写真实库前的只读核实）。

---

## 8. 运行时待核实（实现首步只读核实，写库前必查）

- [ ] `superworker` 生产库 `infringement_*` 表已建、列与 Model 一致
- [ ] rabbitmq agent 用户（1749/2005/962/126）是否已有 entity_auth `entityType='Legal'` 授权行（决定工具对谁可见）
- [ ] 写库需**可写 MySQL 账号**（feed 的 `btclaw_reader` 只读）— 配 `writerDb`
- [ ] OpenClaw 发 RabbitMQ 用 consumer 的 broker 配置（host/port/user/password）
- [ ] `groupId` 来源：`legal_user_role` 是否有 group 字段，无则建案 groupId=0
