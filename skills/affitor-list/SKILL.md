# Affitor List API

Search affiliate programs from list.affitor.com directory.

## Triggers

- "tìm affiliate program"
- "search program"
- "affiliate [keyword]"
- "list affitor"
- "list.affitor.com"

## Authentication

**KHÔNG CẦN API KEY** cho public access. Gọi trực tiếp.

## How to Use

Dùng exec tool để gọi API:

```bash
curl -s "https://list.affitor.com/api/v1/programs"
```

## Response Format

```json
{
  "data": [
    {
      "name": "Program Name",
      "slug": "program-slug",
      "url": "https://affiliate-link",
      "reward_value": "25%",
      "reward_duration": "Recurring",
      "cookie_days": 30,
      "description": "...",
      "tags": ["ai", "saas"]
    }
  ],
  "count": 5,
  "tier": "free"
}
```

## Notes

- Free tier: 5 results max, không cần auth
- Unlimited: get API key at list.affitor.com/settings
- Trả về: name, commission rate, cookie days, URL
