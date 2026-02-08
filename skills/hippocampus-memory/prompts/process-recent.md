# Hippocampus: Process Recent Conversation

You've been triggered to run memory encoding. Do this now:

## Step 1: Recall Recent Conversation
Think back to what happened in this session. What topics were discussed? What was shared?

## Step 2: Read Current Index
```
Read memory/index.json
```

## Step 3: Identify New Memories
For each significant thing from the conversation:
- Is it worth remembering? (See importance criteria in ARCHITECTURE.md)
- What domain? (user/self/relationship/world)
- Does it already exist in the index?

## Step 4: Update Index

For NEW memories, add entry:
```json
{
  "id": "mem_XXX",
  "domain": "...",
  "category": "...",
  "content": "Clear, concise description",
  "importance": 0.XX,
  "created": "YYYY-MM-DD",
  "lastAccessed": "YYYY-MM-DD",
  "timesReinforced": 1,
  "keywords": ["...", "..."]
}
```

For EXISTING memories that came up again:
- Increase importance: `new = old + (1-old)*0.15`
- Update lastAccessed
- Increment timesReinforced

## Step 5: Write Updated Index
Save the changes to `memory/index.json`.

## Step 6: Report
Briefly note what was captured/reinforced.

---

**Do this now. Don't just acknowledge — actually process and update the index.**
