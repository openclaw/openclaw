---
name: nas-file-search
description: "Locate files on the mounted NAS rooted at `/mnt/nas` using the built-in `nas_search` tool. Use when the user gives only a NAS filename or partial path and you need the real path before opening or summarizing the file."
metadata:
  {
    "openclaw":
      {
        "emoji": "🗂️",
      },
  }
---

# nas-file-search

Use this skill when the user names a NAS file but does not give the full absolute path.

Hard rule

- Use the built-in `nas_search` tool with `mode="filename"` to locate files under `/mnt/nas`.
- Report the matching NAS-relative paths, and when needed convert them to absolute paths by prefixing `/mnt/nas/`.
- Do not invent shell commands such as `nas-file-search --pattern ...`.
- Do not tell the user to run a command themselves when you can call `nas_search` directly.

Workflow

1. Call `nas_search` with the provided filename and `mode="filename"`.
2. If there is one clear match, use it.
3. If exact filename search returns no matches, retry with 1-3 distinctive fragments from the filename, such as the document type, property name, or unit number.
4. Prefer fragments like `建物賃貸借契約書`, `レジオンスクエア`, or `1119号` over broad year/month prefixes.
5. If there are multiple matches, show the candidate paths and ask the user which one they want.
6. If the next step is opening a `.docx`, hand off to `nas-docx` with the resolved absolute path.

Example

- `nas_search` with `{"query":"202601_建物賃貸借契約書_レジオンスクエア緑地公園1119号.docx","mode":"filename"}`
- If that returns 0, retry `nas_search` with `{"query":"レジオンスクエア","mode":"filename"}` or `{"query":"建物賃貸借契約書","mode":"filename"}`.
