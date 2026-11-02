#!/usr/bin/env python3
"""Reject missing/duplicate/blank native PNGs and incomplete Swift runs."""
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import zlib

NAMES = ("onboarding", "install-note", "endpoint")
REQUIRED = {
    "onboarding": ["Connect your AI", "Set up a local model", "Llama app", "Built-in local AI", "Existing llama.cpp server", "Ollama", "Set up", "Existing model"],
    "install-note": ["Llama app", "Set up Llama app", "Continue", "Cancel"],
    "endpoint": ["Llama app", "Llama app URL", "Submit", "Cancel"],
}

def png_pixels(file, size, region=None):
    data = file.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", file
    offset, compressed, ihdr = 8, bytearray(), None
    while offset < len(data):
        length = struct.unpack(">I", data[offset:offset+4])[0]
        kind = data[offset+4:offset+8]
        payload = data[offset+8:offset+8+length]
        crc = struct.unpack(">I", data[offset+8+length:offset+12+length])[0]
        assert zlib.crc32(kind+payload) & 0xffffffff == crc, file
        if kind == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", payload)
        if kind == b"IDAT":
            compressed.extend(payload)
        offset += 12+length
        if kind == b"IEND":
            break
    assert ihdr is not None and offset == len(data), file
    width, height, depth, color, compression, filtering, interlace = ihdr
    assert (width, height) == size, (file, ihdr, size)
    if region is not None:
        x0, y0, x1, y1 = region
        assert 0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height, (file, region)
    assert depth == 8 and color in (2, 6) and (compression, filtering, interlace) == (0, 0, 0), (file, ihdr)
    channels = 4 if color == 6 else 3
    raw = zlib.decompress(compressed)
    stride = width*channels
    assert len(raw) == height*(stride+1), file
    previous = bytearray(stride)
    colors, nonwhite = set(), 0
    pixel_hash = hashlib.sha256()
    region_hash = hashlib.sha256()
    for y in range(height):
        start = y*(stride+1)
        kind = raw[start]
        row = bytearray(raw[start+1:start+1+stride])
        assert kind in range(5), (file, kind)
        for x in range(stride):
            left = row[x-channels] if x >= channels else 0
            up = previous[x]
            upper_left = previous[x-channels] if x >= channels else 0
            predictor = 0
            if kind == 1:
                predictor = left
            elif kind == 2:
                predictor = up
            elif kind == 3:
                predictor = (left+up)//2
            elif kind == 4:
                p = left+up-upper_left
                distances = (abs(p-left), abs(p-up), abs(p-upper_left))
                predictor = (left, up, upper_left)[distances.index(min(distances))]
            row[x] = (row[x]+predictor) & 255
        pixel_hash.update(row)
        if region is not None and y0 <= y < y1:
            region_hash.update(row[x0*channels:x1*channels])
        for x in range(0, stride, channels):
            rgb = bytes(row[x:x+3])
            if len(colors) < 1024:
                colors.add(rgb)
            if min(rgb) < 220 and (channels == 3 or row[x+3] > 128):
                nonwhite += 1
        previous = row
    assert len(colors) >= 16 and nonwhite >= 100, (file, "blank or nearly blank PNG")
    return {"width": width, "height": height, "sha256": hashlib.sha256(data).hexdigest(),
            "pixelSha256": pixel_hash.hexdigest(), "sampledColors": len(colors), "darkPixels": nonwhite,
            "regionPixelSha256": region_hash.hexdigest() if region is not None else None}

def validate_events(file, suite="LlamaNativeCaptureTests", count=1, issues=0, regression=None):
    discovered, started, ended = {}, set(), set()
    phases, recorded = [], []
    for line in file.read_text().splitlines():
        record = json.loads(line)
        if record.get("kind") not in ("test", "event"):
            continue
        assert record["version"] == "6.3.0", record
        payload = record["payload"]
        if record["kind"] == "test" and payload.get("kind") == "function" and suite in payload["id"]:
            discovered[payload["id"]] = payload.get("name", "")
        if record["kind"] == "event":
            kind, test = payload["kind"], payload.get("testID")
            if kind in ("runStarted", "runEnded"):
                phases.append(kind)
            assert kind not in ("testCancelled", "testSkipped"), payload
            if kind == "issueRecorded":
                recorded.append(test)
            if test in discovered and kind == "testStarted":
                started.add(test)
            if test in started and kind == "testEnded":
                ended.add(test)
    assert phases == ["runStarted", "runEnded"], phases
    assert len(discovered) == count and set(discovered) == started == ended, (discovered, started, ended)
    assert len(recorded) == issues, recorded
    if regression:
        target = [key for key, name in discovered.items() if regression in name or regression in key]
        assert len(target) == 1 and set(recorded) == set(target), (target, recorded)
    return {"completedTests": len(ended), "issues": len(recorded)}

def validate_icon_events(root, stage, contract):
    code = int((root/("icon-tests-"+stage+"-exit.txt")).read_text())
    assert (code != 0) if stage == "before" else (code == 0)
    return {"stage": stage, "exit": code, **validate_events(root/("icon-events-"+stage+".jsonl"),
        contract["iconSuite"], contract["iconTestCount"], contract["expectedBeforeIssues"] if stage == "before" else 0,
        contract["regressionName"] if stage == "before" else None)}

def contains(outer, inner):
    return (math.floor(outer["x"]) <= math.floor(inner["x"]) and
            math.floor(outer["y"]) <= math.floor(inner["y"]) and
            math.ceil(inner["x"]+inner["width"]) <= math.ceil(outer["x"]+outer["width"]) and
            math.ceil(inner["y"]+inner["height"]) <= math.ceil(outer["y"]+outer["height"]))

def geometry(ax, name, contract, required):
    capture = ax["capture"]
    bounds, screen, raster = capture["bounds"], capture["screenBounds"], capture["rasterSize"]
    scale = capture["backingScaleFactor"]
    assert scale in (1, 2) and bounds["width"] > 0 and bounds["height"] > 0
    assert (screen["width"], screen["height"]) == (bounds["width"], bounds["height"])
    if name == "onboarding":
        assert (bounds["width"], bounds["height"]) == (630, 1000)
    else:
        assert bounds["width"] == contract["sheetWidth"] and bounds["height"] >= contract["sheetMinHeight"]
    size = (math.ceil(bounds["width"]*scale), math.ceil(bounds["height"]*scale))
    assert size == (raster["width"], raster["height"]), (size, raster)
    for label in required:
        matches = [node for node in ax["nodes"] if any(label in text for text in node["labels"])]
        assert any(contains(screen, node["screenFrame"]) for node in matches), (name, label, "clipped content")
    assert ax["controls"] and all(contains(screen, node["screenFrame"]) for node in ax["controls"])
    if name == "endpoint":
        assert any(node["role"] == "AXTextField" for node in ax["controls"])
    region = None
    if name == "onboarding":
        row = ax["managedControl"]
        assert row["role"] == "AXButton" and any("Built-in local AI" in text for text in row["labels"])
        frame = row["screenFrame"]
        assert contains(screen, frame)
        region = (math.floor((frame["x"]-screen["x"])*scale),
                  math.floor((screen["y"]+screen["height"]-frame["y"]-frame["height"])*scale),
                  math.ceil((frame["x"]+frame["width"]-screen["x"])*scale),
                  math.ceil((screen["y"]+screen["height"]-frame["y"])*scale))
    return size, region

def verify_freeze(root, name, stage, expected, contract):
    manifest = root/(name+".jsonl")
    receipt = json.loads((root/(name+"-receipt.json")).read_text())
    assert (receipt["commit"], receipt["tree"]) == tuple(expected)
    assert receipt["manifestSha256"] == hashlib.sha256(manifest.read_bytes()).hexdigest()
    rows = [json.loads(line) for line in manifest.read_text().splitlines()]
    assert receipt["stage"] == stage and receipt["matchedBlobs"] == len(rows)
    selected = {row["path"]: row["sha256"] for row in rows}
    assert selected[contract["owner"]] == contract["ownerSha256"]
    return selected

def main(root):
    pins = {
        "before": ("0b584645a34242f72b0566f8cf3acebd9ac63a73", "685b7e59c940a055b0e998276c13ab19a110d6e8"),
        "after": ("adcfa7ca4a204860ff67b5e1db4f45bd7d5c8a17", "12fe3ed2d4c8dfd6757dd54fd6220ba9b74162a3"),
        "core": ("7830780292c95ac7f2e96ecee19cdfb1639393bb", "adba24522319c79af72e3632b4e5483b90af53a4"),
    }
    contract = json.loads((root/"source-contracts.json").read_text())
    freezes = {}
    for stage in ("before", "after", "core"):
        # Core owns fixture copy, not the native sheet; its complete source still freezes independently.
        if stage == "core":
            receipt = json.loads((root/"source-core-receipt.json").read_text())
            manifest = root/"source-core.jsonl"
            assert (receipt["commit"], receipt["tree"]) == pins[stage]
            assert receipt["manifestSha256"] == hashlib.sha256(manifest.read_bytes()).hexdigest()
        else:
            freezes[stage] = verify_freeze(root, "source-"+stage, stage, pins[stage], contract)
            verify_freeze(root, "build-source-"+stage, stage, pins[stage], contract)
    icon_test = "apps/macos/Tests/OpenClawIPCTests/OnboardingProviderIconTests.swift"
    capture_test = "apps/macos/Tests/OpenClawIPCTests/OnboardingAISetupTests.swift"
    original = (root/"original-onboarding-tests.swift").read_bytes()
    overlay = (root/"capture-overlay.swift.append").read_bytes()
    assert hashlib.sha256(original).hexdigest() == freezes["before"][capture_test] == freezes["after"][capture_test]
    overlaid = hashlib.sha256(original+overlay).hexdigest()
    note = json.loads((root/"fixtures/install-note.json").read_text())["step"]["message"]
    rows, tests = [], []
    for stage in ("before", "after"):
        folder = root/stage
        assert sorted(p.name for p in folder.glob("*.png")) == sorted(n+".png" for n in NAMES), folder
        assert (root/("overlaid-"+stage+".sha256")).read_text().split()[0] == overlaid
        assert (root/("icon-tests-"+stage+".sha256")).read_text().split()[0] == freezes["after"][icon_test]
        tests.append(validate_icon_events(root, stage, contract))
        receipt = json.loads((folder/"receipt.json").read_text())
        assert receipt["stage"] == stage and receipt["locale"] == "en_US" and receipt["appearance"] == "light"
        assert receipt["activated"] is False and receipt["inferenceAttempted"] is False
        assert receipt["selectedKind"] is None and receipt["existingModelUntouched"] is True
        assert receipt["appHasBundledMark"] is True and receipt["managedBorrowsAppMark"] == (stage == "before")
        assert receipt["requests"] == ["openclaw.setup.detect", "openclaw.setup.prepare.start", "wizard.next"]
        assert receipt["appHead"] == pins[stage][0] and receipt["gatewayFixtureSource"] == pins["core"][0]
        validate_events(root/("events-"+stage+".jsonl"))
        for name in NAMES:
            ax = json.loads((folder/(name+".accessibility.json")).read_text())
            required = REQUIRED[name] + ([note] if name == "install-note" else [])
            assert all(any(label in found for found in ax["labels"]) for label in required), (stage, name)
            size, region = geometry(ax, name, contract, required)
            row = {"stage": stage, "name": name, "managedRegion": region,
                   "logicalBounds": ax["capture"]["bounds"], **png_pixels(folder/(name+".png"), size, region)}
            rows.append(row)
        assert len({row["pixelSha256"] for row in rows if row["stage"] == stage}) == 3, "Duplicated native frames"
    for name in NAMES:
        pair = [row for row in rows if row["name"] == name]
        assert (pair[0]["width"], pair[0]["height"]) == (pair[1]["width"], pair[1]["height"]), name
        if name == "onboarding":
            assert pair[0]["managedRegion"] == pair[1]["managedRegion"], "Managed row moved between same-fixture captures"
            assert pair[0]["regionPixelSha256"] != pair[1]["regionPixelSha256"], "Managed llama.cpp fallback pixels did not change"
    (root/"pixel-validation.json").write_text(json.dumps({"status": "PASS", "requiresHumanPixelInspection": True,
        "note": "PNG dimensions bind to final native bounds; sheet heights are not the requested seed heights.",
        "iconTests": tests, "frames": rows}, indent=2)+"\n")

def seal(root):
    files = sorted(p for p in root.rglob("*") if p.is_file() and p.name != "OUTPUT-SHA256SUMS")
    (root/"OUTPUT-SHA256SUMS").write_text("".join(hashlib.sha256(p.read_bytes()).hexdigest()+"  "+p.relative_to(root).as_posix()+"\n" for p in files))

if __name__ == "__main__":
    if sys.argv[1] == "--icon-events":
        root = Path(sys.argv[2])
        contract = json.loads((root/"source-contracts.json").read_text())
        print(json.dumps(validate_icon_events(root, sys.argv[3], contract)))
    elif sys.argv[1] == "--seal":
        seal(Path(sys.argv[2]))
    else:
        main(Path(sys.argv[1]))
