# ERP 查询优化方案 - 使用指南

## 📋 目录

1. [快速查询脚本](#1-快速查询脚本)
2. [使用场景](#2-使用场景)
3. [最佳实践](#3-最佳实践)
4. [示例](#4-示例)

---

## 1. 快速查询脚本

### 位置

```
~/openclaw/skills/erp-query/scripts/quick-query.cjs
```

### 命令

#### 查供应商未交订单

```bash
# 基础查询
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs supplier B0069

# 按账龄分组
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs supplier B0069 --aging

# 查最近 N 条订单
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs supplier B0069 --recent 10

# 组合使用
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs supplier B0069 --aging --recent 5 --json

# JSON 输出（适合程序处理）
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs supplier B0069 --json
```

#### 执行自定义 SQL

```bash
# 简单查询
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs sql "SELECT TOP 10 * FROM eba"

# 复杂查询
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs sql "SELECT eba_id, COUNT(*) as cnt FROM ebs_vr GROUP BY eba_id ORDER BY cnt DESC"

# JSON 输出
node ~/openclaw/skills/erp-query/scripts/quick-query.cjs sql "SELECT..." --json
```

### 权限控制入口（推荐给子代理）

```bash
# 查看权限
node ~/openclaw/skills/erp-query/scripts/secure-query.cjs --wecom-user-id 21032565247771 permissions

# 按 ACL 执行 SQL
node ~/openclaw/skills/erp-query/scripts/secure-query.cjs --wecom-user-id 21032565247771 sql "SELECT TOP 20 voucher_no, voucher_type FROM ebs_v WHERE voucher_type IN ('BA','BB')"
```

说明：

- `policy/acl-policy.json` 存在时，`query.cjs` 和 `quick-query.cjs` 会拒绝直接调用，避免子代理绕过 ACL。

### ACL 操作台（管理员）

```bash
# 初始化策略（读取 ERP 表单 + WeCom 用户）
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs init --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"

# 同步表单和用户
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs sync-forms --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs sync-users --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"

# 按 WeCom userId 分配角色
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs assign 21032565247771 sales_manager --name 张三 --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs assign 21032565285572 production_manager --name 王五 --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"

# 首次设置 ACL 变更密钥（未配置过时）
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs set-mutation-secret --operator-wecom-user-id <admin_wecom_user_id> --new-mutation-secret "<new_secret>"

# 轮换 ACL 变更密钥（已配置旧密钥时必须带 --mutation-secret）
node ~/openclaw/skills/erp-query/scripts/acl-console.cjs set-mutation-secret --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<old_secret>" --new-mutation-secret "<new_secret>"
```

### Web 页面操作台（推荐）

```bash
# 启动 Web 控制台（本机访问）
node ~/openclaw/skills/erp-query/scripts/acl-web-server.cjs --host 127.0.0.1 --port 18990 --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"

# 浏览器访问
# http://127.0.0.1:18990/
```

可选：加 Bearer Token 管理口令

```bash
node ~/openclaw/skills/erp-query/scripts/acl-web-server.cjs --host 127.0.0.1 --port 18990 --token "your-token" --operator-wecom-user-id <admin_wecom_user_id> --mutation-secret "<acl_mutation_secret>"
```

---

## 2. 使用场景

### 场景 1: 日常快速查询

```bash
# 问：明胜供应商还有多少未交订单？
node quick-query.cjs supplier B0069

# 输出：
# === 供应商未交订单汇总 ===
# 总订单数：56
# 总金额：¥1162065.46
# 总数量：84021
```

**耗时：** ~200ms  
**准确率：** 100%

---

### 场景 2: 账龄分析

```bash
# 问：明胜供应商的未交订单账龄分布？
node quick-query.cjs supplier B0069 --aging

# 输出：
# === 账龄分析 ===
# <3 月：25 笔，¥606243.62
# >1 年：26 笔，¥518371.44
# 6 月 -1 年：5 笔，¥37450.40
```

**耗时：** ~300ms  
**用途：** 风险评估、催货优先级

---

### 场景 3: AI 生成报告

```bash
# 1. 查数据
node quick-query.cjs supplier B0069 --aging --json > /tmp/data.json

# 2. 复制 JSON 给 AI
"根据以下数据生成供应商分析报告：[粘贴 JSON]"

# 3. AI 输出专业报告
```

**耗时：** ~5 秒（AI 处理）  
**用途：** 周报、月报、管理层汇报

---

### 场景 4: 复杂业务查询

```bash
# 问：哪些供应商的未交订单超过 100 万？

# AI 生成 SQL:
SELECT vr.eba_id, e.eba_name, SUM(vi.total_amount)/100.0 as amount
FROM ebs_v v
JOIN ebs_vr_item vi ON v.voucher_id = vi.voucher_id
JOIN ebs_vr vr ON v.voucher_id = vr.voucher_id
JOIN eba e ON vr.eba_id = e.eba_id
WHERE v.voucher_type = 'AA' AND v.state = 'B'
GROUP BY vr.eba_id, e.eba_name
HAVING SUM(vi.total_amount)/100.0 > 1000000
ORDER BY amount DESC

# 执行 SQL:
node quick-query.cjs sql "SELECT..."
```

**耗时：** ~500ms  
**用途：** 供应链风险分析

---

## 3. 最佳实践

### ✅ 推荐做法

| 场景     | 推荐方案                 | 原因          |
| -------- | ------------------------ | ------------- |
| 简单查数 | 直接用 `quick-query.cjs` | 最快、最准    |
| 账龄分析 | `--aging` 参数           | 内置优化 SQL  |
| 数据导出 | `--json` 参数            | 方便程序处理  |
| 报告生成 | 脚本查数据 + AI 解读     | 准确 + 专业   |
| 复杂查询 | AI 生成 SQL + 脚本执行   | 灵活 + 可验证 |

### ❌ 避免做法

| 做法                | 问题             | 替代方案              |
| ------------------- | ---------------- | --------------------- |
| 让 AI 直接查数据库  | 超时、Token 浪费 | 用脚本查 + AI 分析    |
| 复杂 SQL 手敲       | 易出错           | AI 生成 → 验证 → 执行 |
| 一次性查全量数据    | 慢、内存溢出     | 加 `TOP N` 限制       |
| 不验证 SQL 直接执行 | 可能误操作       | 先用 `SELECT` 测试    |

---

## 4. 示例

### 示例 1: 供应商对账

```bash
# 查明胜供应商汇总
node quick-query.cjs supplier B0069

# 查最近 20 条明细
node quick-query.cjs supplier B0069 --recent 20

# 导出 JSON 给财务系统
node quick-query.cjs supplier B0069 --aging --json > supplier_B0069.json
```

### 示例 2: 月度分析报告

```bash
# 1. 查所有供应商汇总
node quick-query.cjs sql "
  SELECT vr.eba_id, e.eba_name,
         COUNT(*) as order_count,
         SUM(vi.total_amount)/100.0 as total_amount
  FROM ebs_v v
  JOIN ebs_vr_item vi ON v.voucher_id = vi.voucher_id
  JOIN ebs_vr vr ON v.voucher_id = vr.voucher_id
  JOIN eba e ON vr.eba_id = e.eba_id
  WHERE v.voucher_type = 'AA' AND v.state = 'B'
  GROUP BY vr.eba_id, e.eba_name
  ORDER BY total_amount DESC
" --json > monthly_report.json

# 2. 给 AI
"根据以下数据生成月度供应商分析报告，包括：
1. 总体情况
2. Top 5 供应商
3. 风险提示
4. 建议

数据：[粘贴 JSON]"
```

### 示例 3: 风险预警

```bash
# 查逾期>1 年的订单
node quick-query.cjs sql "
  SELECT vr.eba_id, e.eba_name,
         COUNT(*) as overdue_count,
         SUM(vi.total_amount)/100.0 as overdue_amount
  FROM ebs_v v
  JOIN ebs_vr_item vi ON v.voucher_id = vi.voucher_id
  JOIN ebs_vr vr ON v.voucher_id = vr.voucher_id
  JOIN eba e ON vr.eba_id = e.eba_id
  WHERE v.voucher_type = 'AA' AND v.state = 'B'
    AND v.voucher_date < '20250225'
  GROUP BY vr.eba_id, e.eba_name
  HAVING COUNT(*) > 5
  ORDER BY overdue_amount DESC
"
```

---

## 📞 支持

遇到问题？检查以下事项：

1. **数据库连接** - 确认服务器 `192.168.3.250` 可达
2. **权限** - 确认用户 `OpenClaw_Reader` 有读取权限
3. **脚本路径** - 使用完整路径 `~/openclaw/skills/erp-query/scripts/quick-query.cjs`
4. **Node 模块** - 确认 `mssql` 已安装 `npm list mssql`

---

_最后更新：2026-02-25_
