# 单元格值格式参考

`smartsheet_add_records` 仅支持**字段标题**作为key。
`smartsheet_update_records` 支持通过 `key_type` 参数指定使用字段标题（`CELL_VALUE_KEY_TYPE_FIELD_TITLE`）或字段 ID（`CELL_VALUE_KEY_TYPE_FIELD_ID`）。

## 各字段类型的值格式

### 1. 文本 (FIELD_TYPE_TEXT)

**必须**使用数组格式，外层方括号不可省略：

```json
"字段标题": [{"type": "text", "text": "内容"}]
```

### 2. 数字 (NUMBER) / 货币 (CURRENCY) / 百分比 (PERCENTAGE) / 进度 (PROGRESS)

直接传数字：

```json
"金额": 100,
"完成率": 0.6,
"进度": 80
```

### 3. 复选框 (CHECKBOX)

直接传布尔值：

```json
"已完成": true
```

### 4. 单选 (SINGLE_SELECT) / 多选 (SELECT)

**必须**使用数组格式，不能直接传字符串：

```json
"优先级": [{"text": "高"}],
"标签": [{"text": "紧急", "style": 17}, {"text": "重要", "style": 12}]
```

已存在的选项应通过 `id` 匹配（`id` 可从 `smartsheet_get_fields` 返回中获取），新增选项时不填 `id`。可附带 `style`（颜色 1-27），对照表如下：

| style | 颜色 |
|-------|------|
| 1 | 浅红1 |
| 2 | 浅橙1 |
| 3 | 浅天蓝1 |
| 4 | 浅绿1 |
| 5 | 浅紫1 |
| 6 | 浅粉红1 |
| 7 | 浅灰1 |
| 8 | 白 |
| 9 | 灰 |
| 10 | 浅蓝1 |
| 11 | 浅蓝2 |
| 12 | 蓝 |
| 13 | 浅天蓝2 |
| 14 | 天蓝 |
| 15 | 浅绿2 |
| 16 | 绿 |
| 17 | 浅红2 |
| 18 | 红 |
| 19 | 浅橙2 |
| 20 | 橙 |
| 21 | 浅黄1 |
| 22 | 浅黄2 |
| 23 | 黄 |
| 24 | 浅紫2 |
| 25 | 紫 |
| 26 | 浅粉红2 |
| 27 | 粉红 |

### 5. 日期时间 (DATE_TIME)

传日期时间字符串，系统自动按东八区转换：

```json
"截止日期": "2026-01-15 14:30:00",
"创建日期": "2026-01-15"
```

支持格式：`YYYY-MM-DD HH:MM:SS`、`YYYY-MM-DD HH:MM`、`YYYY-MM-DD`

### 6. 手机号 (PHONE_NUMBER) / 邮箱 (EMAIL) / 条码 (BARCODE)

直接传字符串：

```json
"电话": "13800138000",
"邮箱": "test@example.com"
```

### 7. 成员 (USER)

数组格式，需传 user_id。**user_id 不是姓名**，必须先通过 `wecom-contact-lookup` 技能查找目标人员的 `userid`，再填入此处。

具体步骤：先使用 `wecom_mcp` tool 调用 `wecom_mcp call contact get_userlist '{}'` 获取通讯录成员列表，在返回结果中按姓名/别名筛选出目标人员，取其 `userid` 值填入。

```json
"负责人": [{"user_id": "zhangsan"}]
```

多个成员：

```json
"负责人": [{"user_id": "zhangsan"}, {"user_id": "lisi"}]
```

### 8. 超链接 (URL)

数组格式，目前仅支持一个链接：

```json
"参考链接": [{"type": "url", "text": "官网", "link": "https://example.com"}]
```

### 9. 图片 (IMAGE)

数组格式：

```json
"封面": [{"image_url": "https://example.com/img.png"}]
```

### 10. 地理位置 (LOCATION)

数组格式：

```json
"地点": [{"source_type": 1, "id": "地点ID", "latitude": "39.9", "longitude": "116.3", "title": "北京"}]
```

## 完整添加记录示例

```json
{
    "docid": "DOCID",
    "sheet_id": "SHEETID",
    "records": [{
        "values": {
            "任务名称": [{"type": "text", "text": "完成需求文档"}],
            "优先级": [{"text": "高"}],
            "截止日期": "2026-03-20",
            "完成进度": 30,
            "已完成": false
        }
    }]
}
```

