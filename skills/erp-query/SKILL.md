---
name: erp-query
description: "Query the company ERP database (htjx2021, SQL Server). Activate when user mentions ERP, asks about customers, suppliers, sales, purchases, inventory, payments, receivables, payables, employees, attendance, wages, production, or any business data lookup. Trigger words: ERP, 客户, 供应商, 销售, 采购, 库存, 收款, 付款, 应收, 应付, 员工, 考勤, 工资, 生产, 物料, 进账, 出账, 对账, 单据."
---

# ERP Query Skill

Query the htjx2021 ERP database (SQL Server on 192.168.3.250, read-only).

## Quick Start

**推荐方式**：优先使用快速查询脚本（速度快、数据准）：

```bash
# 查供应商未交订单（已自动扣除入库数量）
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs supplier B0069

# 带账龄分析
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs supplier B0069 --aging

# 最近 N 条明细
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs supplier B0069 --recent 20

# 指定年份
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs supplier B0069 --year 2025

# JSON 输出
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs supplier B0069 --json
```

**自定义 SQL**（复杂查询使用）：

```bash
node ~/openclaw/skills/erp-query/scripts/query.cjs "SELECT TOP 10 eba_id, eba_name FROM eba"
```

输出 JSON lines，一行一条记录。始终用 `TOP N` 限制结果集。

## ACL 权限操作台（企业微信 userId）

多子代理场景下，推荐启用 ACL：按企业微信用户 ID 分配角色，仅允许查询对应业务表单。

### 1) 初始化权限策略

```bash
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs init --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"
```

会生成策略文件：

- `~/openclaw/skills/erp-query/policy/acl-policy.json`

### 2) 同步 ERP 表单与企业微信用户

```bash
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs sync-forms --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs sync-users --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"
```

### 3) 按 userId 分配角色

```bash
# 张三（销售主管）只看销售
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs assign <zhangsan_wecom_user_id> sales_manager --name 张三 --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"

# 王五（生产主管）看生产/库存
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs assign <wangwu_wecom_user_id> production_manager --name 王五 --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"

# 首次设置 ACL 变更密钥（未配置过时）
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs set-mutation-secret --operator-wecom-user-id <admin_wecom_user_id> --new-mutation-secret "<new_secret>"

# 轮换 ACL 变更密钥（已配置时）
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs set-mutation-secret --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<old_secret>" --new-mutation-secret "<new_secret>"
```

### 4) 通过安全查询入口执行

```bash
# 查看当前用户权限
node ~/openclaw/skills/erp-query/scripts/secure-query.cjs --wecom-user-id <id> permissions

# 安全执行 SQL（会校验表与 voucher_type）
node ~/openclaw/skills/erp-query/scripts/secure-query.cjs --wecom-user-id <id> sql "SELECT TOP 20 voucher_no, voucher_type FROM ebs_v WHERE voucher_type IN ('BA','BB')"

# 安全执行供应商未交查询
node ~/openclaw/skills/erp-query/scripts/secure-query.cjs --wecom-user-id <id> supplier B0069 --json
```

> 注意：多子代理时，不要把 `query.cjs` 直接暴露给代理；统一走 `secure-query.cjs`。
>
> 当 `policy/acl-policy.json` 存在时，`query.cjs` / `quick-query.cjs` 会拒绝直接调用（防绕过）。必须走 `secure-query.cjs`。

### 5) 启动 Web 权限操作台

```bash
node ~/openclaw/skills/erp-query/scripts/acl-web-server.cjs --host 127.0.0.1 --port 18990 --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"
```

浏览器打开：

- `http://127.0.0.1:18990/`

可选开启 Token 保护：

```bash
node ~/openclaw/skills/erp-query/scripts/acl-web-server.cjs --host 127.0.0.1 --port 18990 --token "<your_token>" --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"
```

## 子代理权限拒绝回复规范（强制）

当 ERP 查询被拒绝（包括 ACL 拒绝，或工具层拦截如 `exec allowlist miss`）时：

1. 只能回复：`当前没有权限。`
2. 不提供任何建议、下一步、代操作话术，不得出现“如果你同意我可以帮你加权限/临时放行”等内容。
3. 不主动执行或建议执行 ACL 变更命令（`assign`、`unassign`、`sync-*`、`set-mutation-secret`、`init`）。
4. 权限拒绝后立即结束本次查询，不继续尝试绕过或替代路径。
5. 禁止建议用户手动执行任何本地命令（包括 `node ...secure-query.cjs ...`）。

## Key Conventions

- **金额单位是分**：除以 100 得到元。适用于 `amount`, `total_amount`, `inp_amount`, `should_in`, `pre_in`, `io_amount` 等字段
- **日期是字符串**：格式 `YYYYMMDD`（如 `20260228`），用字符串比较做日期范围过滤
- **状态字段**：`A` = 草稿, `B` = 已审核, `C` = 已关闭
- **voucher_id**：关联 `ebs_v`（单据头）到明细表（`ebs_vr`, `ebs_vr_item`, `ebm_mio` 等）
- **中文公司名**：搜索用 `LIKE N'%关键词%'`（N 前缀支持 Unicode）
- **默认查当年**：除非用户指定年份，否则查当年数据

## Core Tables

| 模块   | 表名          | 用途       | 关键字段                                                            |
| ------ | ------------- | ---------- | ------------------------------------------------------------------- |
| 客户   | `eba`         | 客户主表   | `eba_id`, `eba_name`, `should_in`(应收), `pre_in`(预收)             |
| 客户   | `eba_io`      | 销售流水   | `eba_id`, `voucher_id`, `total_amount`, `inp_num`                   |
| 供应商 | `sup`         | 供应商主表 | `sup_id`, `sup_name`, `should_out`(应付), `pre_out`(预付)           |
| 供应商 | `sup_io`      | 采购流水   | `sup_id`, `voucher_id`, `total_amount`                              |
| 单据   | `ebs_v`       | 单据头     | `voucher_id`, `voucher_type`, `voucher_no`, `voucher_date`, `state` |
| 单据   | `ebs_vr`      | 单据关联   | `voucher_id`, `eba_id`, `edt_id`, `io_amount`                       |
| 单据   | `ebs_vr_item` | 单据明细行 | `voucher_id`, `res_id`, `inp_num`, `total_amount`, `ref_voucher_id` |
| 收付款 | `ebm_mio`     | 收付款记录 | `voucher_id`, `eba_id`, `amount`, `account_id`                      |
| 库存   | `edt_res`     | 当前库存   | `edt_id`, `res_id`, `num`                                           |
| 物料   | `res`         | 物料主表   | `res_id`, `res_name`, `res_model`, `res_spec`                       |

## Voucher Types (常用单据类型)

- **BA**: 销售订单, **BB**: 销售发货单, **BC**: 销售开票, **BF**: 销售退货
- **AA**: 采购订单, **AB**: 采购入库单, **AC**: 采购开票, **AF**: 采购退货
- **CB**: 收款单, **CA**: 预收款, **DB**: 付款单, **DA**: 预付款
- **CC**: 应收款单, **DC**: 应付款单, **EA**: 应收核销, **EB**: 应付核销

## 错误处理

脚本内置自动重试（最多 2 次）。常见错误：

| 错误                    | 原因              | 解决                           |
| ----------------------- | ----------------- | ------------------------------ |
| 连接超时 (ETIMEOUT)     | 服务器不可达      | 检查 VPN/内网连接              |
| 连接被拒 (ECONNREFUSED) | SQL Server 未启动 | 联系 IT 检查服务               |
| 登录失败 (ELOGIN)       | 用户名密码错误    | 检查 db 配置                   |
| 连接丢失                | 并发查询过多      | 等待后重试，避免同时 >3 个查询 |

**并发限制**：连接池上限 3 个连接。避免同时启动超过 3 个 ERP 查询子代理。

## 更多参考

- 详细 SQL 查询模板：`references/queries.md`
- 完整数据库 schema（810 张表）：`references/schema.md`
- 使用指南和最佳实践：`USAGE.md`
