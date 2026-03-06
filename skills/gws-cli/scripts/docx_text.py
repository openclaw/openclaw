#!/usr/bin/env python3
import re
import sys
import zipfile
from html import unescape


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: docx_text.py /path/to/file.docx", file=sys.stderr)
        return 2

    path = sys.argv[1]
    with zipfile.ZipFile(path) as zf:
      xml = zf.read("word/document.xml").decode("utf-8", "ignore")

    text = re.sub(r"<w:tab[^>]*/>", "\t", xml)
    text = re.sub(r"</w:p>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = unescape(text)
    lines = [line.strip() for line in text.splitlines()]
    lines = [line for line in lines if line]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
