# Naver News Search API Reference

## API Endpoint

```
https://openapi.naver.com/v1/search/news.json
```

## Authentication

Required HTTP Headers:
- `X-Naver-Client-Id`: Application Client ID
- `X-Naver-Client-Secret`: Application Client Secret

Get credentials at: https://developers.naver.com/

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | String | Yes | Search query (UTF-8 encoded) |
| display | Integer | No | Results per page (1-100, default: 10) |
| start | Integer | No | Start position (1-1000, default: 1) |
| sort | String | No | Sort method: `sim` (relevance) or `date` (date, default) |

## Response Structure

```json
{
  "lastBuildDate": "Mon, 26 Sep 2016 11:01:35 +0900",
  "total": 2566589,
  "start": 1,
  "display": 10,
  "items": [
    {
      "title": "기사 제목 (<b> 태그로 검색어 강조)",
      "originallink": "http://example.com/article",
      "link": "http://openapi.naver.com/...",
      "description": "기사 요약 (<b> 태그로 검색어 강조)",
      "pubDate": "Mon, 26 Sep 2016 07:50:00 +0900"
    }
  ]
}
```

## Response Fields

- `lastBuildDate`: Search timestamp
- `total`: Total number of results
- `start`: Start position
- `display`: Number of results returned
- `items`: Array of news articles
  - `title`: Article title (search terms wrapped in `<b>` tags)
  - `originallink`: Original article URL
  - `link`: Naver News URL (or original if not on Naver)
  - `description`: Article summary (search terms wrapped in `<b>` tags)
  - `pubDate`: Publication date

## Error Codes

| Code | HTTP Status | Message | Description |
|------|-------------|---------|-------------|
| SE01 | 400 | Incorrect query request | Check URL protocol/parameters |
| SE02 | 400 | Invalid display value | display must be 1-100 |
| SE03 | 400 | Invalid start value | start must be 1-1000 |
| SE04 | 400 | Invalid sort value | sort must be 'sim' or 'date' |
| SE06 | 400 | Malformed encoding | Query must be UTF-8 |
| SE05 | 404 | Invalid search api | Check API URL |
| SE99 | 500 | System Error | Server error |

## Rate Limits

- 25,000 calls per day per application

## Example Request

```bash
curl "https://openapi.naver.com/v1/search/news.json?query=주식&display=10&start=1&sort=date" \
  -H "X-Naver-Client-Id: YOUR_CLIENT_ID" \
  -H "X-Naver-Client-Secret: YOUR_CLIENT_SECRET"
```
