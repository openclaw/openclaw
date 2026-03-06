---
name: nas-docx
description: "Read and summarize `.docx` files stored on mounted local volumes such as `/mnt/nas`. Use when the user asks about the contents of a NAS Word document, provides a NAS file path ending in `.docx`, or asks to summarize a contract/application document from the mounted NAS."
metadata:
  {
    "openclaw":
      {
        "emoji": "📄",
        "requires": { "bins": ["python3"] },
      },
  }
---

# nas-docx

Use this skill for mounted NAS `.docx` files. Do not summarize from the filename alone.

Hard rule

- When the user asks about a NAS `.docx` file, extract the actual document text first and only then summarize.
- The gateway is allowed to access the mounted NAS through the NAS plugin rooted at `/mnt/nas`; do not claim that `/mnt/nas` is inaccessible without first trying the workflow below.
- Use only the bundled helper: `/usr/bin/python3 /home/deepnoa/openclaw/skills/nas-docx/scripts/docx_text.py <ABSOLUTE_PATH_TO_DOCX>`.
- Do not use `nas_read` or `nas_summary` on a `.docx` file. A `.docx` is a ZIP container, so those tools will return binary PK data rather than readable document text.
- Do not use `unzip`, shell heredocs, inline Python, or guess the contents from the title.
- If extraction fails, report the extraction failure instead of inventing a summary.

When to use

- User names a NAS file ending in `.docx`
- User asks to summarize a Word contract or application stored on the mounted NAS
- User asks to inspect a document found from the NAS file list

Workflow

1. If the user already gives an absolute NAS path, use it directly.
2. If the user gives only a filename or partial path, first call `nas_search` with `mode="filename"` to locate the file under NAS root.
3. Convert the NAS-relative result to an absolute path by prefixing `/mnt/nas/`.
4. Run `/usr/bin/python3 /home/deepnoa/openclaw/skills/nas-docx/scripts/docx_text.py <path>`.
5. If the output is large, read the first portion, then summarize purpose, parties, dates, amounts, addresses, and major sections.
6. For legal/contract documents, prefer a structured summary over freeform prose.

Do not say

- "I do not have permission to access /mnt/nas" unless both `nas_search` and the helper execution actually fail.
- "Please run nas-docx --extract-text" because that is not a real command in this workspace.
- "I can only summarize if you paste the contents" unless extraction genuinely failed.
- Raw `PK...` output from `nas_read`; that means you read the DOCX container instead of extracting the text.

Example

- `python3 /home/deepnoa/openclaw/skills/nas-docx/scripts/docx_text.py "/mnt/nas/02601_建物賃貸借契約書_レジオンスクエア緑地公園1119号.docx"`
- If only the filename is known, first run `nas_search` with `{"query":"202601_建物賃貸借契約書_レジオンスクエア緑地公園1119号.docx","mode":"filename"}` and then extract from the matching `/mnt/nas/...` path.

Summary guidance

- State document type first
- Identify parties, property/item, important dates, money terms, renewal/cancellation clauses, and special obligations
- If a field is missing from extracted text, say it was not visible in the extracted text

Troubleshooting

- If exec is denied, the gateway allowlist likely needs `/usr/bin/python3`
- If the file path is relative or ambiguous, locate the exact NAS path first with `nas_search`
- If you see `PK` binary output, restart from step 4 and run the bundled helper instead of `nas_read`
- This skill is for `.docx`; legacy `.doc` may require separate tooling
