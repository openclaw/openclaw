from pathlib import Path
path = Path(r"c:\git\openclaw\src\utils\provider-utils.ts")
text = path.read_text(encoding="utf-8")
old = '    normalized === "ollama" ||\n    normalized === "litellm" ||\n    normalized === "google-gemini-cli" ||\n'
new = '    normalized === "ollama" ||\n    normalized === "litellm" ||\n    normalized.startswith("litellm/") ||\n    normalized === "google-gemini-cli" ||\n'
if old not in text:
    raise SystemExit('pattern not found')
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print('updated')
