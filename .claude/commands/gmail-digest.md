Fetch a compact Gmail digest using the MCP Gmail tools.

$ARGUMENTS

## Purpose

Return structured email summaries with minimal token usage — only the fields needed, never full bodies unless explicitly requested.

## Parameters (from $ARGUMENTS)

- `--query <string>` — Gmail search query (required)
- `--max <n>` — max emails to return (default: 20)
- `--account <email>` — Gmail account to search (default: currently authenticated)
- `--body` — include truncated body snippet (default: subject+from+date+attachments only)
- `--full-body <id>` — fetch full body of a single message by ID only

## Process

### Default mode (no --body flag)

1. Call `gmail_search_messages` with the provided query and max limit
2. For each result extract ONLY:
   - `id` — message ID
   - `from` — sender name + email
   - `subject` — subject line
   - `date` — received date (YYYY-MM-DD HH:MM)
   - `attachments` — list of filenames only (not content)
3. Return as compact JSON array — do NOT read message body or thread

### With --body flag

1. Same as above but also extract a 200-character snippet from the body
2. Still do NOT fetch full message content

### With --full-body <id>

1. Fetch the single message by ID using `gmail_read_message`
2. Return full body for that one message only

## Output Format

```json
{
  "query": "<the search query used>",
  "account": "<account searched>",
  "count": 5,
  "messages": [
    {
      "id": "18f3a...",
      "from": "Meralco Billing <billing@meralco.com.ph>",
      "subject": "Your January 2025 Electric Bill",
      "date": "2025-01-10 08:23",
      "attachments": ["Meralco_Jan2025.pdf"]
    }
  ]
}
```

## Token Rules

- NEVER load email body unless `--body` or `--full-body` is specified
- NEVER include raw HTML, headers dump, or full thread in output
- Cap snippet at 200 characters even with `--body`
- If >20 emails match, note count and ask user to narrow query before fetching more

## Usage Examples

Search for utility bills:

```
/gmail-digest --query "from:(meralco.com.ph OR pldt.com.ph OR globe.com.ph) newer_than:3m" --max 10
```

Search for flight tickets:

```
/gmail-digest --query "subject:(e-ticket OR \"booking confirmation\" OR itinerary) newer_than:7d" --max 20
```

Search for lab results:

```
/gmail-digest --query "subject:(lab results OR blood test OR health report) has:attachment newer_than:6m" --max 5
```

Fetch body of one specific email:

```
/gmail-digest --full-body 18f3a2b4c5d6e7f8
```
