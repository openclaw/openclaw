# 模板卡片类型 - JSON Schema 定义

> 来源：企业微信开发者文档 https://developer.work.weixin.qq.com/document/path/101032
> 格式：JSON Schema，所有字段名、类型、嵌套层级必须严格遵循

---

## 公共结构体 Schema

以下结构体在多种卡片类型中复用，**字段名必须完全一致**。

### MainTitle

```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string", "description": "一级标题，建议不超过26字" },
    "desc":  { "type": "string", "description": "标题辅助信息，建议不超过30字" }
  }
}
```

### Source

```json
{
  "type": "object",
  "properties": {
    "icon_url":  { "type": "string", "description": "来源图片URL" },
    "desc":      { "type": "string", "description": "来源描述，建议不超过13字" },
    "desc_color": { "type": "integer", "enum": [0, 1, 2, 3], "description": "来源文字颜色，只能是0(灰)、1(黑)、2(红)、3(绿)" }
  }
}
```

### CardAction

```json
{
  "type": "object",
  "required": ["type"],
  "properties": {
    "type":     { "type": "integer", "enum": [1, 2], "description": "1=跳转url 2=打开小程序（严格只能是1或2）" },
    "url":      { "type": "string", "description": "跳转url，type=1时必填" },
    "appid":    { "type": "string", "description": "小程序appid，type=2时必填" },
    "pagepath": { "type": "string", "description": "小程序pagepath" }
  }
}
```

### EmphasisContent

```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string", "description": "关键数据内容，建议不超过10字" },
    "desc":  { "type": "string", "description": "关键数据描述，建议不超过15字" }
  }
}
```

### SubmitButton

```json
{
  "type": "object",
  "required": ["text", "key"],
  "properties": {
    "text": { "type": "string", "description": "按钮文案，建议不超过10字" },
    "key":  { "type": "string", "description": "提交按钮的key，用于回调事件" }
  }
}
```

### Button

```json
{
  "type": "object",
  "required": ["text", "key"],
  "properties": {
    "text":  { "type": "string", "description": "按钮文案，建议不超过10字" },
    "style": { "type": "integer", "enum": [1, 2, 3, 4], "description": "按钮样式，只能是1、2、3、4，默认1" },
    "key":   { "type": "string", "description": "按钮key，用于回调事件" }
  }
}
```

### Checkbox（投票选择题）

```json
{
  "type": "object",
  "required": ["question_key", "option_list"],
  "properties": {
    "question_key": { "type": "string", "description": "选择题key，用于回调事件" },
    "mode":         { "type": "integer", "enum": [0, 1], "description": "0=单选 1=多选（严格只能是0或1，不允许2或其他值），默认0" },
    "option_list": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "required": ["id", "text"],
        "properties": {
          "id":         { "type": "string", "description": "选项id，不可重复" },
          "text":       { "type": "string", "description": "选项文案，建议不超过11字" },
          "is_checked": { "type": "boolean", "description": "是否默认选中" }
        }
      }
    }
  }
}
```

### SelectionItem（下拉选择器）

```json
{
  "type": "object",
  "required": ["question_key", "option_list"],
  "properties": {
    "question_key": { "type": "string", "description": "选择器key，用于回调事件，不可重复" },
    "title":        { "type": "string", "description": "选择器标题，建议不超过13字" },
    "selected_id":  { "type": "string", "description": "默认选定的option id" },
    "option_list": {
      "type": "array",
      "minItems": 1,
      "maxItems": 10,
      "items": {
        "type": "object",
        "required": ["id", "text"],
        "properties": {
          "id":   { "type": "string", "description": "选项id，不可重复" },
          "text": { "type": "string", "description": "选项文案，建议不超过10字" }
        }
      }
    }
  }
}
```

### HorizontalContent

```json
{
  "type": "object",
  "required": ["keyname"],
  "properties": {
    "type":    { "type": "integer", "enum": [0, 1, 3], "description": "只能是0(普通文本)、1(跳转url)、3(成员详情)，注意没有2" },
    "keyname": { "type": "string", "description": "二级标题，建议不超过5字" },
    "value":   { "type": "string", "description": "二级文本，建议不超过26字" },
    "url":     { "type": "string", "description": "跳转url，type=1时必填" },
    "userid":  { "type": "string", "description": "成员userid，type=3时必填" }
  }
}
```

### JumpAction

```json
{
  "type": "object",
  "required": ["title"],
  "properties": {
    "type":     { "type": "integer", "enum": [0, 1, 2, 3], "description": "只能是0(无链接)、1(url)、2(小程序)、3(智能回复)" },
    "title":    { "type": "string", "description": "文案内容，建议不超过13字" },
    "url":      { "type": "string", "description": "跳转url，type=1时必填" },
    "appid":    { "type": "string", "description": "小程序appid，type=2时必填" },
    "pagepath": { "type": "string", "description": "小程序pagepath" },
    "question": { "type": "string", "description": "智能问答问题，type=3时必填" }
  }
}
```

### QuoteArea

```json
{
  "type": "object",
  "properties": {
    "type":       { "type": "integer", "enum": [0, 1, 2], "description": "只能是0(无点击)、1(url)、2(小程序)" },
    "url":        { "type": "string" },
    "title":      { "type": "string", "description": "引用标题" },
    "quote_text": { "type": "string", "description": "引用文案" }
  }
}
```

### CardImage

```json
{
  "type": "object",
  "required": ["url"],
  "properties": {
    "url":          { "type": "string", "description": "图片url" },
    "aspect_ratio": { "type": "number", "description": "宽高比，1.3~2.25，默认1.3" }
  }
}
```

---

## 1. text_notice Schema

```json
{
  "type": "object",
  "required": ["card_type", "card_action", "task_id"],
  "properties": {
    "card_type":        { "const": "text_notice" },
    "source":           { "$ref": "#Source" },
    "main_title":       { "$ref": "#MainTitle", "description": "main_title.title 和 sub_title_text 至少填一个" },
    "emphasis_content":  { "$ref": "#EmphasisContent" },
    "sub_title_text":   { "type": "string", "description": "二级文本，建议不超过112字" },
    "horizontal_content_list": { "type": "array", "maxItems": 6, "items": { "$ref": "#HorizontalContent" } },
    "jump_list":        { "type": "array", "maxItems": 3, "items": { "$ref": "#JumpAction" } },
    "card_action":      { "$ref": "#CardAction", "description": "必填" },
    "task_id":          { "type": "string", "description": "必填，格式：task_{描述}_{时间戳}" }
  }
}
```

---

## 2. news_notice Schema

```json
{
  "type": "object",
  "required": ["card_type", "main_title", "card_action", "task_id"],
  "properties": {
    "card_type":        { "const": "news_notice" },
    "source":           { "$ref": "#Source" },
    "main_title":       { "$ref": "#MainTitle", "description": "必填" },
    "card_image":       { "$ref": "#CardImage", "description": "card_image 和 image_text_area 至少填一个" },
    "vertical_content_list": { "type": "array", "maxItems": 4, "items": { "type": "object", "required": ["title"], "properties": { "title": { "type": "string" }, "desc": { "type": "string" } } } },
    "horizontal_content_list": { "type": "array", "maxItems": 6, "items": { "$ref": "#HorizontalContent" } },
    "jump_list":        { "type": "array", "maxItems": 3, "items": { "$ref": "#JumpAction" } },
    "card_action":      { "$ref": "#CardAction", "description": "必填" },
    "task_id":          { "type": "string", "description": "必填" }
  }
}
```

---

## 3. button_interaction Schema

```json
{
  "type": "object",
  "required": ["card_type", "main_title", "button_list", "task_id"],
  "properties": {
    "card_type":        { "const": "button_interaction" },
    "source":           { "$ref": "#Source" },
    "main_title":       { "$ref": "#MainTitle", "description": "必填" },
    "sub_title_text":   { "type": "string", "description": "二级文本" },
    "horizontal_content_list": { "type": "array", "maxItems": 6, "items": { "$ref": "#HorizontalContent" } },
    "button_selection": {
      "$ref": "#SelectionItem",
      "description": "可选的下拉选择器，与按钮配合使用"
    },
    "button_list": {
      "type": "array",
      "minItems": 1,
      "maxItems": 6,
      "items": { "$ref": "#Button" },
      "description": "必填，按钮列表"
    },
    "task_id":          { "type": "string", "description": "必填" }
  }
}
```

---

## 4. vote_interaction Schema（简化格式，代码自动转换为 API 格式）

> **不要使用** `checkbox`、`question_key`、`option_list` 等 API 原始字段名。使用以下简化字段，代码会自动组装。

```json
{
  "type": "object",
  "required": ["card_type", "title", "options", "task_id"],
  "properties": {
    "card_type":   { "const": "vote_interaction" },
    "title":       { "type": "string", "description": "投票标题" },
    "description": { "type": "string", "description": "标题描述，可选" },
    "options": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "required": ["id", "text"],
        "properties": {
          "id":   { "type": "string", "description": "选项id，不可重复" },
          "text": { "type": "string", "description": "选项文案" }
        }
      },
      "description": "投票选项列表"
    },
    "mode":        { "type": "integer", "enum": [0, 1], "description": "0=单选 1=多选（严格只能是0或1），默认0" },
    "submit_text": { "type": "string", "description": "提交按钮文案，可选，默认\"提交\"" },
    "task_id":     { "type": "string", "description": "必填，格式：task_{描述}_{时间戳}" }
  }
}
```

---

## 5. multiple_interaction Schema（简化格式，代码自动转换为 API 格式）

> **不要使用** `select_list`、`question_key`、`option_list` 等 API 原始字段名。使用以下简化字段，代码会自动组装。

```json
{
  "type": "object",
  "required": ["card_type", "title", "selectors", "task_id"],
  "properties": {
    "card_type":   { "const": "multiple_interaction" },
    "title":       { "type": "string", "description": "卡片标题" },
    "description": { "type": "string", "description": "标题描述，可选" },
    "selectors": {
      "type": "array",
      "minItems": 1,
      "maxItems": 3,
      "items": {
        "type": "object",
        "required": ["title", "options"],
        "properties": {
          "title": { "type": "string", "description": "此选择器的标题" },
          "options": {
            "type": "array",
            "minItems": 1,
            "maxItems": 10,
            "items": {
              "type": "object",
              "required": ["id", "text"],
              "properties": {
                "id":   { "type": "string", "description": "选项id，不可重复" },
                "text": { "type": "string", "description": "选项文案" }
              }
            }
          }
        }
      },
      "description": "下拉选择器列表，每个选择器包含标题和选项"
    },
    "submit_text": { "type": "string", "description": "提交按钮文案，可选，默认\"提交\"" },
    "task_id":     { "type": "string", "description": "必填，格式：task_{描述}_{时间戳}" }
  }
}
```
