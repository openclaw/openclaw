---
name: web-search
description: Search the web and summarise results
metadata:
  requires:
    tools: ["search"]
  approval: "none"
  agent: "browser"
---

# Web Search

## Goal
Search the web for information and provide a concise summary.

## Steps

### Step 1: Search
- Use the SearXNG search tool with the user's query
- Fetch top 5-10 results

### Step 2: Filter
- Remove duplicate domains
- Prioritise authoritative sources
- Skip paywalled or login-required content

### Step 3: Extract
- For the top 3-5 relevant results, extract key content
- Focus on facts, dates, numbers, and direct answers

### Step 4: Summarise
- Provide a concise answer to the user's question
- Include source URLs for verification
- If results are contradictory, present both sides
