from pathlib import Path
path = Path(r"c:\git\openclaw\src\shared\text\reasoning-tags.test.ts")
text = path.read_text(encoding="utf-8")
old = """    it(\"returns think content when no final tag\", () => {\n      const input = \"<think>Hello</think>\";\n      expect(stripReasoningTagsFromText(input)).toBe(\"Hello\");\n    });\n\n    it(\"returns unclosed think content when no final tag\", () => {\n      const input = \"<think>Hello\";\n      expect(stripReasoningTagsFromText(input)).toBe(\"Hello\");\n    });\n"""
new = """    it(\"returns empty when only closed think tag\", () => {\n      const input = \"<think>Hello</think>\";\n      expect(stripReasoningTagsFromText(input)).toBe(\"\");\n    });\n\n    it(\"returns unclosed think content when no final tag\", () => {\n      const input = \"<think>Hello\";\n      expect(stripReasoningTagsFromText(input)).toBe(\"Hello\");\n    });\n"""
if old not in text:
    raise SystemExit('pattern not found')
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print('updated')
