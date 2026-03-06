---
name: nas-pdf
description: "Extract and summarize text from `.pdf` files stored on mounted local volumes such as `/mnt/nas`. Use when the user asks about the contents of a NAS PDF, provides a NAS file path ending in `.pdf`, or wants a contract/report PDF summarized from the mounted NAS."
metadata:
  {
    "openclaw":
      {
        "emoji": "📕",
        "requires": { "bins": ["python3"] },
      },
  }
---

# nas-pdf

Use this skill for mounted NAS `.pdf` files. Do not summarize from the filename alone.

Hard rule

- When the user asks about a NAS `.pdf` file, extract the actual document text first and only then summarize.
- The gateway is allowed to access the mounted NAS through the NAS plugin rooted at `/mnt/nas`; do not claim that `/mnt/nas` is inaccessible without first trying the workflow below.
- Use only the bundled helper: `/usr/bin/python3 /home/deepnoa/openclaw/skills/nas-pdf/scripts/pdf_text.py <ABSOLUTE_PATH_TO_PDF>`.
- Do not use `nas_read` or `nas_summary` on a `.pdf` file for text extraction.
- Do not use ad-hoc shell pipelines, inline Python, or guess the contents from the title.
- If extraction fails, report the extraction failure instead of inventing a summary.

When to use

- User names a NAS file ending in `.pdf`
- User asks to summarize a contract, notice, or report stored on the mounted NAS as PDF
- User asks to inspect a document found from the NAS file list

Workflow

1. If the user already gives an absolute NAS path, use it directly.
2. If the absolute path fails to open, do not stop there; retry by locating the file with `nas_search` using the basename or 1-3 distinctive fragments from the filename.
3. If the user gives only a filename or partial path, first call `nas_search` with `mode="filename"` to locate the file under NAS root.
4. Convert the NAS-relative result to an absolute path by prefixing `/mnt/nas/`.
5. Run `/usr/bin/python3 /home/deepnoa/openclaw/skills/nas-pdf/scripts/pdf_text.py <path>`.
6. If the output is large, read the first portion, then summarize document type, parties, dates, amounts, addresses, and major sections.
7. For legal or financial documents, prefer a structured summary over freeform prose.

Do not say

- "I do not have permission to access /mnt/nas" unless both `nas_search` and the helper execution actually fail.
- "Please run nas-pdf --extract-text" because that is not a real command in this workspace.
- "I can only summarize if you paste the contents" unless extraction genuinely failed.

Example

- `/usr/bin/python3 /home/deepnoa/openclaw/skills/nas-pdf/scripts/pdf_text.py "/mnt/nas/総務/建物賃貸借契約/202601_建物賃貸借契約書_レジオンスクエア緑地公園1119号.pdf"`
- If that exact path fails, retry `nas_search` with `{"query":"レジオンスクエア","mode":"filename"}` or `{"query":"建物賃貸借契約書","mode":"filename"}` and then use the resolved `/mnt/nas/...` path.

Summary guidance

- State document type first
- Identify parties, property/item, important dates, money terms, renewal/cancellation clauses, and special obligations
- If a field is missing from extracted text, say it was not visible in the extracted text

Troubleshooting

- If exec is denied, the gateway allowlist likely needs `/usr/bin/python3`
- If the file path is relative or ambiguous, locate the exact NAS path first with `nas_search`
- If the exact absolute path appears to exist but the agent still says not found, suspect Unicode normalization or pasted whitespace and re-resolve via `nas_search`
- If extraction yields little or no text, the PDF may be image-only and may require OCR, which this skill does not do
