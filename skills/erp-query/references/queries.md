# ERP 查询模板参考

本文件包含常用的 SQL 查询模板，供 AI 代理生成查询时参考。

## 查客户/供应商

```sql
SELECT eba_id, eba_name, should_in/100.0 as receivable FROM eba WHERE eba_name LIKE N'%关键词%'
SELECT sup_id, sup_name, should_out/100.0 as payable FROM sup WHERE sup_name LIKE N'%关键词%'
```

## 客户收款（进账/收款）

```sql
SELECT v.voucher_date, v.voucher_no, m.amount/100.0 as amount_yuan
FROM ebm_mio m JOIN ebs_v v ON m.voucher_id = v.voucher_id
WHERE m.eba_id = @ebaId AND v.voucher_type = 'CB' AND v.state = 'B'
ORDER BY v.voucher_date DESC
```

## 销售明细

```sql
SELECT voucher_date, voucher_no, voucher_type, res_id, inp_num, total_amount/100.0 as amount_yuan
FROM eba_io WHERE eba_id = @ebaId AND voucher_type = 'BB'
ORDER BY voucher_date DESC
```

## 库存查询

```sql
SELECT r.res_name, r.res_model, er.num, er.edt_id
FROM edt_res er JOIN res r ON er.res_id = r.res_id
WHERE r.res_name LIKE N'%关键词%' AND er.num > 0
```

## 未交采购订单（核心逻辑）

**关键**：采购订单 (AA) 数量 - 已入库数量 (AB 关联 ref_voucher_id) = 真实未交数

### 明细查询

```sql
SELECT aa_v.voucher_no, aa_v.voucher_date, r.res_name, r.res_model,
       aa_item.inp_num as order_qty,
       ISNULL(ab_sum.in_qty, 0) as received_qty,
       aa_item.inp_num - ISNULL(ab_sum.in_qty, 0) as outstanding_qty,
       (aa_item.total_amount/100.0) * (aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) / NULLIF(aa_item.inp_num, 0) as outstanding_amount
FROM ebs_v aa_v
JOIN ebs_vr aa_vr ON aa_v.voucher_id = aa_vr.voucher_id
JOIN ebs_vr_item aa_item ON aa_v.voucher_id = aa_item.voucher_id
JOIN res r ON aa_item.res_id = r.res_id
LEFT JOIN (
    SELECT ref_voucher_id, res_id, SUM(inp_num) as in_qty
    FROM ebs_vr_item
    WHERE voucher_id IN (SELECT voucher_id FROM ebs_v WHERE voucher_type = 'AB' AND state = 'B')
    AND ref_voucher_type = 'AA'
    GROUP BY ref_voucher_id, res_id
) ab_sum ON aa_item.voucher_id = ab_sum.ref_voucher_id AND aa_item.res_id = ab_sum.res_id
WHERE aa_v.voucher_type = 'AA' AND aa_v.state = 'B'
  AND aa_vr.eba_id = @supId
  AND aa_v.voucher_date >= @yearStart AND aa_v.voucher_date <= @yearEnd
  AND (aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) > 0
ORDER BY aa_v.voucher_date DESC
```

### 汇总查询

```sql
SELECT COUNT(DISTINCT aa_v.voucher_no) as order_count,
       COUNT(*) as line_count,
       SUM(aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) as total_outstanding_qty,
       SUM((aa_item.total_amount/100.0) * (aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) / NULLIF(aa_item.inp_num, 0)) as total_outstanding_amount
FROM ebs_v aa_v
JOIN ebs_vr aa_vr ON aa_v.voucher_id = aa_vr.voucher_id
JOIN ebs_vr_item aa_item ON aa_v.voucher_id = aa_item.voucher_id
LEFT JOIN (
    SELECT ref_voucher_id, res_id, SUM(inp_num) as in_qty
    FROM ebs_vr_item
    WHERE voucher_id IN (SELECT voucher_id FROM ebs_v WHERE voucher_type = 'AB' AND state = 'B')
    AND ref_voucher_type = 'AA'
    GROUP BY ref_voucher_id, res_id
) ab_sum ON aa_item.voucher_id = ab_sum.ref_voucher_id AND aa_item.res_id = ab_sum.res_id
WHERE aa_v.voucher_type = 'AA' AND aa_v.state = 'B'
  AND aa_vr.eba_id = @supId
  AND (aa_item.inp_num - ISNULL(ab_sum.in_qty, 0)) > 0
```

**要点**：

- 入库单通过 `ref_voucher_id` 关联采购订单
- 按 `ref_voucher_id + res_id` 分组汇总已入库数量
- 金额按未交比例分摊：`订单金额 × 未交数 / 订单数`
- 过滤 `(inp_num - ISNULL(ab_sum.in_qty, 0)) > 0` 排除已交完的行

## 销售订单查询（今日新增）

### 按明细

```sql
SELECT v.voucher_no, v.voucher_date, e.eba_name, r.res_name, r.res_model,
       i.inp_num, i.tax_price/100.0 as unit_price_tax,
       i.total_amount/100.0 as amount,
       v.create_user_id, v.state
FROM ebs_v v
JOIN ebs_vr vr ON v.voucher_id = vr.voucher_id
JOIN eba e ON vr.eba_id = e.eba_id
JOIN ebs_vr_item i ON v.voucher_id = i.voucher_id
JOIN res r ON i.res_id = r.res_id
WHERE v.voucher_type = 'BA'
  AND v.voucher_date = @date
ORDER BY v.voucher_no, r.res_name
```

### 按订单汇总

```sql
SELECT v.voucher_no, v.voucher_date, v.create_user_id, v.state, e.eba_name,
       SUM(i.total_amount)/100.0 as total_amount
FROM ebs_v v
JOIN ebs_vr vr ON v.voucher_id = vr.voucher_id
JOIN eba e ON vr.eba_id = e.eba_id
JOIN ebs_vr_item i ON v.voucher_id = i.voucher_id
WHERE v.voucher_type = 'BA'
  AND v.voucher_date = @date
GROUP BY v.voucher_no, v.voucher_date, v.create_user_id, v.state, e.eba_name
ORDER BY v.voucher_no
```
