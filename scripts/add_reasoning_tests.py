from pathlib import Path
path = Path(r"c:\git\openclaw\src\shared\text\reasoning-tags.test.ts")
text = path.read_text(encoding="utf-8")
old = """    it(\"strips multiple reasoning blocks\", () => {\n      const input = \"<think>first</think>A<think>second</think>B\";\n      expect(stripReasoningTagsFromText(input)).toBe(\"AB\");\n    });\n"""
new = old + """\n    it(\"returns think content when no final tag\", () => {\n      const input = \"<think>Hello</think>\";\n      expect(stripReasoningTagsFromText(input)).toBe(\"Hello\");\n    });\n\n    it(\"returns unclosed think content when no final tag\", () => {\n      const input = \"<think>Hello\";\n      expect(stripReasoningTagsFromText(input)).toBe(\"Hello\");\n    });\n"""
if old not in text:
    raise SystemExit('pattern not found')
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print('updated')
