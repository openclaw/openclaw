#!/usr/bin/env python3
"""Reject missing/duplicate/blank native PNGs and incomplete Swift runs."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import zlib

NAMES = ("onboarding", "install-note", "endpoint")
REQUIRED = {
    "onboarding": ["Connect your AI", "Set up a local model", "Llama", "Connect Llama", "Existing model"],
    "install-note": ["Llama", "Connect Llama", "Continue", "Cancel"],
    "endpoint": ["Llama", "Llama URL", "Submit", "Cancel"],
}

def png_pixels(file, size):
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
    assert (width, height) in (size, (size[0]*2, size[1]*2)), (file, ihdr)
    assert depth == 8 and color in (2, 6) and (compression, filtering, interlace) == (0, 0, 0), (file, ihdr)
    channels = 4 if color == 6 else 3
    raw = zlib.decompress(compressed)
    stride = width*channels
    assert len(raw) == height*(stride+1), file
    previous = bytearray(stride)
    colors, nonwhite = set(), 0
    pixel_hash = hashlib.sha256()
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
        for x in range(0, stride, channels):
            rgb = bytes(row[x:x+3])
            if len(colors) < 1024:
                colors.add(rgb)
            if min(rgb) < 220 and (channels == 3 or row[x+3] > 128):
                nonwhite += 1
        previous = row
    assert len(colors) >= 16 and nonwhite >= 100, (file, "blank or nearly blank PNG")
    return {"width": width, "height": height, "sha256": hashlib.sha256(data).hexdigest(),
            "pixelSha256": pixel_hash.hexdigest(), "sampledColors": len(colors), "darkPixels": nonwhite}

def validate_events(file):
    discovered, started, ended = set(), set(), set()
    phases = []
    for line in file.read_text().splitlines():
        record = json.loads(line)
        if record.get("kind") not in ("test", "event"):
            continue
        assert record["version"] == "6.3.0", record
        payload = record["payload"]
        if record["kind"] == "test" and payload.get("kind") == "function":
            if "LlamaNativeCaptureTests" in payload["id"] and "nativeOnboardingCapture" in payload["id"]:
                discovered.add(payload["id"])
        if record["kind"] == "event":
            kind, test = payload["kind"], payload.get("testID")
            if kind in ("runStarted", "runEnded"):
                phases.append(kind)
            assert kind not in ("issueRecorded", "testCancelled", "testSkipped"), payload
            if test in discovered and kind == "testStarted":
                started.add(test)
            if test in started and kind == "testEnded":
                ended.add(test)
    assert phases == ["runStarted", "runEnded"] and len(ended) == 1, (phases, ended)

def main(root):
    rows = []
    for stage in ("before", "after"):
        folder = root/stage
        assert sorted(p.name for p in folder.glob("*.png")) == sorted(n+".png" for n in NAMES), folder
        receipt = json.loads((folder/"receipt.json").read_text())
        assert receipt["stage"] == stage and receipt["locale"] == "en_US" and receipt["appearance"] == "light"
        assert receipt["activated"] is False and receipt["inferenceAttempted"] is False
        assert receipt["selectedKind"] is None and receipt["existingModelUntouched"] is True
        assert receipt["requests"] == ["openclaw.setup.detect", "openclaw.setup.prepare.start", "wizard.next"]
        assert receipt["appHead"] == {"before": "88d2ee6be575aa96ec4951796f9b831f4d522207", "after": "0b584645a34242f72b0566f8cf3acebd9ac63a73"}[stage]
        assert receipt["gatewayFixtureSource"] == "abefc2847e1af7f218c00dced963dc7700f34568"
        validate_events(root/("events-"+stage+".jsonl"))
        for name in NAMES:
            ax = json.loads((folder/(name+".accessibility.json")).read_text())
            assert all(any(label in found for found in ax["labels"]) for label in REQUIRED[name]), (stage, name)
            size = {"onboarding": (630, 1000), "install-note": (500, 380), "endpoint": (500, 300)}[name]
            rows.append({"stage": stage, "name": name, **png_pixels(folder/(name+".png"), size)})
        assert len({row["pixelSha256"] for row in rows if row["stage"] == stage}) == 3, "Duplicated native frames"
    for name in NAMES:
        pair = [row for row in rows if row["name"] == name]
        assert (pair[0]["width"], pair[0]["height"]) == (pair[1]["width"], pair[1]["height"]), name
        if name == "onboarding":
            assert pair[0]["pixelSha256"] != pair[1]["pixelSha256"], "Before/After onboarding pixels are identical"
    (root/"pixel-validation.json").write_text(json.dumps({"status": "PASS", "requiresHumanPixelInspection": True,
        "note": "Sheet pairs may match: reviewed artwork changes the surrounding onboarding page, not wizard copy.", "frames": rows}, indent=2)+"\n")

def seal(root):
    # Called only after the runner closes and joins its log writer.
    files = sorted(p for p in root.rglob("*") if p.is_file() and p.name != "OUTPUT-SHA256SUMS")
    (root/"OUTPUT-SHA256SUMS").write_text("".join(hashlib.sha256(p.read_bytes()).hexdigest()+"  "+p.relative_to(root).as_posix()+"\n" for p in files))

if __name__ == "__main__":
    if sys.argv[1] == "--seal":
        seal(Path(sys.argv[2]))
    else:
        main(Path(sys.argv[1]))
