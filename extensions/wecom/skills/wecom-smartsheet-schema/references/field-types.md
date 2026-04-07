# 智能表格字段类型参考

## 支持的字段类型

| 类型枚举值 | 说明 | 适用场景 |
|---|---|---|
| `FIELD_TYPE_TEXT` | 文本 | 名称、标题、描述、负责人姓名等自由文本 |
| `FIELD_TYPE_NUMBER` | 数字 | 金额、工时、数量等数值 |
| `FIELD_TYPE_CHECKBOX` | 复选框 | 是否完成等布尔值 |
| `FIELD_TYPE_DATE_TIME` | 日期时间 | 截止日期、创建时间等 |
| `FIELD_TYPE_IMAGE` | 图片 | 附件图片 |
| `FIELD_TYPE_USER` | 用户/成员 | 需传入 user_id；仅在明确知道成员 ID 时使用，若只有姓名应用 TEXT |
| `FIELD_TYPE_URL` | 链接 | 超链接 |
| `FIELD_TYPE_SELECT` | 多选 | 标签、分类等可多选的选项 |
| `FIELD_TYPE_PROGRESS` | 进度 | 完成进度（0-100 整数） |
| `FIELD_TYPE_PHONE_NUMBER` | 手机号 | 联系电话 |
| `FIELD_TYPE_EMAIL` | 邮箱 | 电子邮件 |
| `FIELD_TYPE_SINGLE_SELECT` | 单选 | 状态、优先级、严重程度等有固定选项的字段 |
| `FIELD_TYPE_LOCATION` | 位置 | 地理位置 |
| `FIELD_TYPE_CURRENCY` | 货币 | 货币金额 |
| `FIELD_TYPE_PERCENTAGE` | 百分比 | 比率类数值（完成率、转化率） |
| `FIELD_TYPE_BARCODE` | 条码 | 条形码/二维码 |

## 添加字段示例

```json
{
    "docid": "DOCID",
    "sheet_id": "SHEETID",
    "fields": [
        { "field_title": "任务名称", "field_type": "FIELD_TYPE_TEXT" },
        { "field_title": "优先级", "field_type": "FIELD_TYPE_SINGLE_SELECT" },
        { "field_title": "截止日期", "field_type": "FIELD_TYPE_DATE_TIME" },
        { "field_title": "完成进度", "field_type": "FIELD_TYPE_PROGRESS" }
    ]
}
```

## 更新字段注意事项

- `smartsheet_update_fields` **只能更新字段标题**，不能更改字段类型
- `field_type` 必须传字段当前的原始类型
- `field_title` 不能更新为原值（即不能传与当前相同的标题）
