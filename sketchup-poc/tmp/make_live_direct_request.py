import json, uuid
from pathlib import Path

req = json.loads(Path('samples/live-extractor/live-extractor-request.from-bridge-handoff.json').read_text())
req['requestId'] = f"live-direct-{uuid.uuid4().hex[:8]}"
req['target']['sketchupExecutablePathHint'] = r"C:\Program Files\SketchUp\SketchUp 2026\SketchUp\SketchUp.exe"
req['target']['sketchupVersionHint'] = '2026'
req['target']['sketchupProcessId'] = None
base = r"C:\OpenClaw\SketchUpPoC"
req['artifacts']['responseArtifactPath'] = base + r"\live-direct-response.json"
req['artifacts']['outputArtifactPath'] = base + r"\live-direct-output.json"
req['artifacts']['snapshotOutputPath'] = base + r"\live-direct-snapshot.json"
req['options']['sketchupExePath'] = req['target']['sketchupExecutablePathHint']
Path('tmp/live-direct-request.json').write_text(json.dumps(req, indent=2) + '\n')
print(req['requestId'])
