---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: nano-pdf（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Edit PDFs with natural-language instructions using the nano-pdf CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://pypi.org/project/nano-pdf/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "📄",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["nano-pdf"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "uv",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "uv",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "package": "nano-pdf",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["nano-pdf"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install nano-pdf (uv)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# nano-pdf（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `nano-pdf` to apply edits to a specific page in a PDF using a natural-language instruction.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
nano-pdf edit deck.pdf 1 "Change the title to 'Q3 Results' and fix the typo in the subtitle"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Page numbers are 0-based or 1-based depending on the tool’s version/config; if the result looks off by one, retry with the other.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Always sanity-check the output PDF before sending it out.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
