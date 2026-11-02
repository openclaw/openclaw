"""Read capture constraints from the admitted native source, not seed window heights."""
import hashlib, json, re, sys
from pathlib import Path
source, output = map(Path, sys.argv[1:])
name = "apps/macos/Sources/OpenClaw/OnboardingAISetupSheet.swift"
data = (source / name).read_bytes()
text = data.decode()
assert re.search(r"\.frame\(width: 500\)", text)
assert re.search(r"\.frame\(minHeight: 220\)", text)
result = {"owner": name, "ownerSha256": hashlib.sha256(data).hexdigest(),
          "sheetWidth": 500, "sheetMinHeight": 220,
          "iconSuite": "OnboardingProviderIconTests", "iconTestCount": 5,
          "regressionName": "llama.cpp does not borrow the Llama app mark",
          "expectedBeforeIssues": 3}
output.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
