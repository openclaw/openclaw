---
summary: "CLI reference for `mullusi docs` (search the live docs index)"
read_when:
  - You want to search the live Mullusi docs from the terminal
title: "docs"
---

# `mullusi docs`

Search the live docs index.

Arguments:

- `[query...]`: search terms to send to the live docs index

Examples:

```bash
mullusi docs
mullusi docs browser existing-session
mullusi docs sandbox allowHostControl
mullusi docs gateway token secretref
```

Notes:

- With no query, `mullusi docs` opens the live docs search entrypoint.
- Multi-word queries are passed through as one search request.
