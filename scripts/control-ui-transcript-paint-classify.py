#!/usr/bin/env python3
"""Classify captured transcript pixels, optionally with marker-associated attribution.

Usage: python3 scripts/control-ui-transcript-paint-classify.py ROOT OUTPUT
       [--expected-bundles 0,1,2] [--baseline 0]
ROOT contains observations.jsonl, *.transcript-layout.json and their frame folders.
Requires Python 3, ImageMagick (magick), and FFmpeg. Use --expected-bundles 0
for a single-arm diagnostic. Marked audits need three stable ruler calibrations.

Only passed, undropped 1440x1000 captures enter comparisons. Fixed crop/masks
are for the synthetic completed-run fixture; inspect them before other uses.
Counts describe captured images, not refreshes, duration, CPU, or stale text.
A/B/C are observed associations, not causal or synchronized compositor traces.
C only means substantial whole text rectangles coincide with missing captured ink;
rectangles are not glyph masks, and descendant clipping/visibility is unobserved.
"""
import argparse
import collections
import hashlib
import json
import math
import re
import statistics
import subprocess
from pathlib import Path

VERSION = 1
MIN_C_TEXT_RECT_AREA = 320
MASKS = [(488, 895, 1262, 990), (855, 849, 897, 891)]
INK = bytes(1 if value < 180 else 0 for value in range(256))
CLASSES = ("blank", "sparse", "populated")
NOTES = [
    "Blank/sparse/populated describe captured pixels, not semantic correctness, staleness, or display-refresh counts.",
    "Full-resolution gray<180 ink; blank requires exactly zero ink pixels; any nonzero ink is sparse or populated. Sparse vertical extent<55% or occupied scanlines<11%. A scanline is occupied with>4 ink pixels.",
    "This strict zero-ink definition supersedes the former <320-pixel low-ink cutoff; old blank counts can include visible partial text and are not directly comparable.",
    "Unmarked audits retain the same 120px left exclusion as marked audits; fixed controls are masked.",
    "Active windows match the reviewed classifier: first trusted wheel of each sign through the last>0.5px scroll movement or wheel, plus1/60s, bounded by the next direction.",
    "Capture timestamps are compared with performance.now via timeOrigin; Firefox/WebKit cross-clock membership is approximate.",
    "Pooled arm fractions and unweighted observation fractions are both reported. Only valid passed observations enter comparison summaries.",
]


LABELS = {"a": "marker-associated range or legacy mounted-coverage gap", "b": "admission/visibility evidence",
          "c": "frame-associated DOM-ready mismatch", "d": "ambiguous or other"}
CAVEATS = [
    "Pixel counts are captured images, not display refreshes or blank duration.",
    "Classification is operational and marker-associated: independent snapshot-marker and content layers may present different revisions. Backward agreement does not prove a compositor fence.",
    "The next snapshot is recovery evidence, not a classification veto. Its timestamp may precede swap while its layers have not reached that captured compositor frame.",
    "C is DOM-ready-but-blank evidence, not a certified raster defect; descendant clipping/visibility not recorded by the probe remains unobserved.",
    "C requires zero captured ink and at least 320 square pixels from wholly visible text rectangles throughout the decoded offset interval. This excludes edge slivers but does not estimate glyph ink coverage.",
    "A requires absence of coverage from the stored virtual-range model, mounted models, physical rows and hidden slots. Legacy captures without range extents support only an observational mounted-coverage gap, not certified range lag.",
    "Shifted mounted model or stored range overlap without physical coverage is D, not range lag. Raw model intersections conservatively use the full crop width and can include masked-edge/gutter ambiguity.",
    "All model slots use the captured block-to-first-active-model origin; older captures derive it from the first active row. This accounts for shared header/scrollMargin/reader shifts, not cumulative per-row size differences. Missing origin is D when coverage cannot otherwise be established.",
    "Stored range extents use the live virtualizer's cached first/last models without invoking its calculations. A common model-to-document offset is not itself a layout fault.",
    "Ruler scanlines implying offsets outside the observed transcript extent are absent/corrupt reference pixels, not valid competing offsets; intact lines must still agree independently.",
    "The synthetic-fixture crop and control masks are fixed; different viewports/fixtures require inspected masks.",
    "Cross-clock active-window membership is approximate outside Chromium. Marker IDs, not timestamps, select snapshots.",
    "Probe layout reads and extra paint invalidate timing comparisons. Calibration requires a stable result, unchanged bracketed offset, and three agreeing phases. Extent changes are allowed only away from scroll boundaries: the ruler has fixed pixel periods.",
]


def decode_ruler(data, conf, width, max_offset=None):
    low, high, lines, outside = -math.inf, math.inf, 0, 0
    for y in range(math.ceil(conf["top"]) + 8, math.floor(conf["bottom"]) - 8):
        values = [data[y * width + round(conf["left"] + (bit + .5) * conf["stripWidth"])]
                  for bit in range(conf["bits"])]
        if not all(value < 70 or value > 185 for value in values):
            continue
        code = sum((value > 185) << bit for bit, value in enumerate(values))
        dy = y + .5 - conf["top"]
        candidate_low = conf["quantum"] * code - dy
        candidate_high = conf["quantum"] * (code + 1) - dy
        if max_offset is not None and (candidate_high < -conf["quantum"] or candidate_low > max_offset + conf["quantum"]):
            outside += 1
            continue
        low = max(low, candidate_low)
        high = min(high, candidate_high)
        lines += 1
    return low, high, lines, outside


def intersect(a, b):
    rect = (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))
    return rect if rect[2] > rect[0] and rect[3] > rect[1] else None


def unmasked(rect, crop):
    rect = intersect(rect, crop)
    pieces = [rect] if rect else []
    for mask in MASKS:
        next_pieces = []
        for piece in pieces:
            overlap = intersect(piece, mask)
            if not overlap:
                next_pieces.append(piece)
                continue
            x0, y0, x1, y1 = piece
            a, b, c, d = overlap
            next_pieces.extend(r for r in [(x0, y0, x1, b), (x0, d, x1, y1),
                                           (x0, b, a, d), (c, b, x1, d)]
                               if r[2] > r[0] and r[3] > r[1])
        pieces = next_pieces
    return pieces


def hidden(style):
    return (style.get("display") == "none" or style.get("visibility", "visible") != "visible"
            or float(style.get("opacity", 1)) == 0 or style.get("contentVisibility") == "hidden")


def clipped_body(row):
    rect = (row["left"], row["top"], row["left"] + row["width"], row["top"] + row["height"])
    clip = row["style"].get("clip", "auto")
    if clip == "auto":
        return rect, None
    parts = re.fullmatch(r"rect\((.*?)\)", clip)
    if not parts:
        return rect, "unsupported legacy clip"
    values = re.split(r"[,\s]+", parts[1].strip())
    if len(values) != 4:
        return rect, "unsupported legacy clip"
    limits = [0, row["width"], row["height"], 0]
    try:
        values = [limits[i] if value == "auto" else float(value.removesuffix("px"))
                  for i, value in enumerate(values)]
    except ValueError:
        return rect, "unsupported legacy clip units"
    top, right, bottom, left = values
    return intersect(rect, (row["left"] + left, row["top"] + top,
                            row["left"] + right, row["top"] + bottom)), None


def project(rect, sample, offset, common=False):
    """Union for possible coverage; common intersection for guaranteed coverage."""
    low, high = offset
    top_offset, bottom_offset = (low, high) if common else (high, low)
    return (rect[0], rect[1] + sample["viewport"]["top"] - top_offset,
            rect[2], rect[3] + sample["viewport"]["top"] - bottom_offset)


def assess(sample, offset, crop):
    if not sample or sample.get("activeKeys") is None:
        return {"cause": "d", "reason": "missing committed owner snapshot"}
    if any(hidden(style) for style in sample["ancestors"]):
        return {"cause": "b", "reason": "recorded transcript ancestor hidden", "evidence": ["ancestor"]}
    if any(style.get("clipPath", "none") != "none" or style.get("clip", "auto") != "auto"
           for style in sample["ancestors"]):
        return {"cause": "d", "reason": "unmodeled ancestor clipping"}
    rows = sample["rows"]
    anchor = next((row for row in rows if not row["prepared"] and row.get("model")), None)
    origin = sample.get("modelOrigin")
    origin_source = "captured-block" if origin is not None else None
    if origin is None and anchor:
        origin = anchor["top"] - anchor["model"]["start"]
        origin_source = "derived-first-active-row"
    range_model = sample.get("rangeModel")
    range_coverage = None
    if range_model and origin is not None:
        viewport_height = sample["viewport"]["bottom"] - sample["viewport"]["top"]
        range_coverage = (range_model["last"]["end"] + origin > offset[0]
                          and range_model["first"]["start"] + origin < offset[1] + viewport_height)
    physical, intended, glyphs, raw_models, uncertain = [], [], [], [], []
    text_rect_area = 0
    whole_text_rect_area = 0
    for row in rows:
        key = row.get("key", str(row["index"]))
        model = row.get("model")
        if model and origin is not None and unmasked(project(
                (crop[0], model["start"] + origin, crop[2], model["end"] + origin), sample, offset), crop):
            raw_models.append(row["index"])
        if hidden(row["style"]):
            if row["prepared"] and model and origin is not None:
                slot = (crop[0], model["start"] + origin, crop[2], model["end"] + origin)
                if unmasked(project(slot, sample, offset, common=True), crop):
                    intended.append(key)
            elif row["prepared"] and origin is None:
                uncertain.append("hidden prepared slot lacks an active origin")
            elif not row["prepared"]:
                body = (row["left"], row["top"], row["left"] + row["width"], row["top"] + row["height"])
                if unmasked(project(body, sample, offset, common=True), crop):
                    intended.append(key)
            continue
        body, error = clipped_body(row)
        if error or row["style"].get("clipPath", "none") != "none":
            uncertain.append(error or "unmodeled row clip-path")
        if not body:
            continue
        if unmasked(project(body, sample, offset), crop):
            physical.append(key)
            if row.get("textRects") is None:
                uncertain.append("text geometry omitted outside sampled viewport")
        for text in row.get("textRects") or []:
            text_bounds = (text[0], text[1], text[0] + text[2], text[1] + text[3])
            glyph = intersect(body, text_bounds)
            pieces = unmasked(project(glyph, sample, offset, common=True), crop) if glyph else []
            if pieces:
                glyphs.append((key, tuple(round(value, 2) for value in glyph)))
                area = sum((right - left) * (bottom - top) for left, top, right, bottom in pieces)
                text_rect_area += area
                possible = project(text_bounds, sample, offset)
                if glyph == text_bounds and unmasked(possible, crop) == [possible]:
                    whole_text_rect_area += area
    evidence = {"physicalRows": physical, "hiddenPreparedSlots": intended,
                "glyphRows": sorted(set(key for key, _ in glyphs)), "rawModelRows": raw_models,
                "rangeModel": range_model, "rangeModelCoverage": range_coverage,
                "modelOrigin": origin, "modelOriginSource": origin_source,
                "preparedSlotOrigin": origin, "textRectArea": text_rect_area,
                "wholeTextRectArea": whole_text_rect_area}
    if uncertain:
        return {**evidence, "cause": "d", "reason": "; ".join(sorted(set(uncertain)))}
    # A clipped line can expose only blank font padding or a few painted pixels.
    # Whole bounds still do not establish painted glyphs; C remains an association.
    if glyphs and whole_text_rect_area < MIN_C_TEXT_RECT_AREA:
        return {**evidence, "cause": "d", "reason": "only partial or negligible text rectangle coverage"}
    if glyphs:
        return {**evidence, "cause": "c", "reason": "unmasked clipped text rectangles cover the decoded offset interval",
                "evidence": sorted(glyphs)}
    if intended:
        return {**evidence, "cause": "b", "reason": "hidden row or prepared intended slot covers the decoded offset interval",
                "evidence": sorted(intended)}
    if not physical:
        if origin is None:
            return {**evidence, "cause": "d", "reason": "model-to-document origin unavailable"}
        if raw_models:
            return {**evidence, "cause": "d", "reason": "shifted mounted row model overlaps the decoded viewport without physical or hidden-slot coverage"}
        if "rangeModel" not in sample:
            return {**evidence, "cause": "a", "coverageScope": "legacy-mounted-only",
                    "reason": "no mounted model, physical row or hidden slot covers the decoded viewport; legacy capture has no virtual range extent"}
        if range_coverage is None:
            return {**evidence, "cause": "d", "reason": "stored virtual range model extent unavailable"}
        if range_coverage:
            return {**evidence, "cause": "d", "reason": "shifted stored virtual range model overlaps the decoded viewport without physical or hidden-slot coverage"}
        return {**evidence, "cause": "a", "coverageScope": "stored-range",
                "reason": "stored virtual range model, mounted models, physical rows and hidden slots do not cover the decoded viewport"}
    return {**evidence, "cause": "d", "reason": "physical row coverage without proven visible glyph coverage"}


def calibrate(audit, directory, conf, width, height):
    intervals, results = [], []
    for item in audit.get("paintCalibrations", []):
        before = item.get("before", item)
        after = item.get("after")
        result = {"file": item["file"], "preliminary": after is None,
                  "before": {key: before.get(key) for key in ("scrollTop", "scrollHeight", "stable")}, "after": after}
        if not after or before.get("stable") is not True or "scrollHeight" not in before:
            results.append({**result, "valid": False, "reason": "missing stable calibration or before/after bracket"})
            continue
        if abs(before["scrollTop"] - after["scrollTop"]) > .1:
            results.append({**result, "valid": False, "reason": "calibration offset changed across capture"})
            continue
        extent_changed = before["scrollHeight"] != after["scrollHeight"]
        if extent_changed:
            # Fixed-pixel local backgrounds depend on offset, not tail height.
            # Retain the extent gate near clamps; the three phases must still agree.
            margin = conf["quantum"]
            viewport_height = conf["bottom"] - conf["top"]
            if not (margin < before["scrollTop"]
                    and before["scrollTop"] + viewport_height + margin
                    < min(before["scrollHeight"], after["scrollHeight"])):
                results.append({**result, "valid": False, "reason": "calibration extent changed near a scroll boundary"})
                continue
        result["extentChangedAtInteriorOffset"] = extent_changed
        raw = subprocess.check_output(["magick", str(directory / item["file"]), "-colorspace", "Gray", "-depth", "8", "gray:-"])
        if len(raw) != width * height:
            results.append({**result, "valid": False, "reason": "calibration image dimensions differ"})
            continue
        low, high, lines, _ = decode_ruler(raw, conf, width)
        valid = low < high and lines > 32
        phase = (low - before["scrollTop"], high - before["scrollTop"]) if valid else None
        results.append({**result, "valid": valid, "lines": lines, "rawOffset": (low, high) if valid else None,
                        "phase": phase, "reason": None if valid else "calibration ruler does not decode consistently"})
        if valid:
            intervals.append(phase)
    phase = (max((x[0] for x in intervals), default=0), min((x[1] for x in intervals), default=0))
    return {"phase": phase, "valid": len(intervals) >= 3 and phase[0] < phase[1],
            "preliminary": any(item["preliminary"] for item in results), "captures": results}

def attribute(data, audit, samples, calibration, crop, width, height, at):
    marker = [data[(height - 6) * width + round((i + .5) * 6)] for i in range(20)]
    valid = (marker[0] < 70 and marker[1] > 185 and marker[18] < 70 and marker[19] > 185
             and all(value < 70 or value > 185 for value in marker[2:18]))
    sid = sum((value > 185) << bit for bit, value in enumerate(marker[2:18])) if valid else None
    max_extent = max((sample["scrollHeight"] for sample in samples.values()), default=0)
    low, high, lines, outside = decode_ruler(data, audit["paintProbe"], width, max_extent)
    result = {"cause": "d", "reason": "missing/invalid snapshot marker", "snapshotId": sid,
              "markerValid": valid, "rulerLines": lines, "rulerOutsideExtentLines": outside,
              "rulerExtentUpperBound": max_extent}
    if not calibration["valid"]:
        result["reason"] = "missing, unstable or inconsistent explicit ruler calibration"
    elif not (lines > 32 and low < high):
        result["reason"] = ("scrolling ruler absent from capture" if lines == 0 and outside > 32
                            else "ruler offset cannot be decoded consistently")
    elif sid in samples:
        phase = calibration["phase"]
        offset = (low - phase[1], high - phase[0])
        previous, candidate, recovery = [assess(samples.get(key), offset, crop)
                                         for key in (sid - 1, sid, sid + 1)]
        marked = samples[sid]
        following = samples.get(sid + 1)
        result.update(offset=offset, snapshotAssessments=[previous, candidate, recovery],
                      markerTiming={"sampleStartedAt": marked["at"],
                                    "markerPublishedAt": marked.get("markerPublishedAt"), "swapAt": at,
                                    "nextSampleStartedAt": following.get("at") if following else None,
                                    "nextMarkerPublishedAt": following.get("markerPublishedAt") if following else None},
                      recovery={"nextSnapshotId": sid + 1 if following else None,
                                "cause": recovery["cause"], "reason": recovery["reason"]})
        if sid - 1 not in samples:
            result["reason"] = "missing previous snapshot"
        elif previous["cause"] != candidate["cause"]:
            result["reason"] = "backward snapshot cause disagreement: " + previous["cause"] + "/" + candidate["cause"]
        elif candidate["cause"] in ("b", "c") and previous["evidence"] != candidate["evidence"]:
            result["reason"] = "backward snapshot evidence changed"
        else:
            result.update(cause=candidate["cause"], reason=candidate["reason"])
            if candidate["cause"] == "a":
                result["coverageScope"] = candidate["coverageScope"]
    return result


def windows(audit):
    groups = []
    for event in audit["input"]:
        if event["type"] != "wheel" or not event.get("trusted") or not event.get("deltaY"):
            continue
        direction = "down" if event["deltaY"] > 0 else "up"
        if not groups or groups[-1]["direction"] != direction:
            groups.append({"direction": direction, "startMs": event["at"], "lastInputMs": event["at"], "wheelEvents": 0})
        groups[-1]["lastInputMs"] = event["at"]
        groups[-1]["wheelEvents"] += 1
    for index, group in enumerate(groups):
        limit = groups[index + 1]["startMs"] if index + 1 < len(groups) else math.inf
        moves = [after["at"] for before, after in zip(audit["frames"], audit["frames"][1:])
                 if group["startMs"] <= after["at"] < limit and abs(after["scrollTop"] - before["scrollTop"]) > .5]
        group["lastMovementMs"] = max(moves, default=group["lastInputMs"])
        group["movementSamples"] = len(moves)
        group["endMs"] = min(limit, max(group["lastInputMs"], group["lastMovementMs"]) + 1000 / 60)
    return groups


def metrics(frames):
    counts = collections.Counter(frame["class"] for frame in frames)
    return totals(counts)


def totals(counts):
    count = sum(counts[key] for key in CLASSES)
    return {**{key: counts[key] for key in CLASSES}, "captures": count,
            "blankFraction": counts["blank"] / count if count else None,
            "sparseFraction": counts["sparse"] / count if count else None,
            "incompleteFraction": (counts["blank"] + counts["sparse"]) / count if count else None}


def initial_bounce(audit):
    """Same-node residual after the native wheel and before interpolation (#195097)."""
    wheels = [item for item in audit["input"] if item.get("type") == "wheel"
              and item.get("trusted") and item.get("deltaY")]
    if not wheels or "scrollWrites" not in audit:
        return None
    start = wheels[0]["at"]
    end = next((item["at"] for item in audit["scrollWrites"]
                if item.get("api") == "scrollTop" and item["at"] > start), None)
    before = next((frame for frame in reversed(audit["frames"]) if frame["at"] < start), None)
    if end is None or before is None:
        return {"gap": "no pre-wheel frame or first interpolation write"}
    inputs = [item for item in wheels if start <= item["at"] <= end]
    if any(item.get("deltaMode") != 0 for item in inputs):
        return {"gap": "non-pixel wheel input"}
    intent = sum(item["deltaY"] for item in inputs)
    original = {row["id"]: row for row in before["rows"]}
    raw, screen = [], []
    for frame in audit["frames"]:
        if not start <= frame["at"] <= end:
            continue
        for row in frame["rows"]:
            if row["id"] not in original:
                continue
            delta = row["top"] - original[row["id"]]["top"]
            raw.append(abs(delta + frame["scrollTop"] - before["scrollTop"]))
            if frame["scrollTop"] != before["scrollTop"]:
                screen.append(abs(delta + intent))
    if not raw or not screen:
        return {"gap": "no common row after native movement and before interpolation"}
    return {"rawDocumentResidualPx": max(raw), "screenResidualPx": max(screen),
            "trustedWheelDeltaPx": intent, "commonRowSamples": len(screen)}


def classify(path, metadata, classifier_hash):
    audit = json.loads(path.read_text())
    if metadata.get("status") != "passed":
        raise ValueError("scenario did not pass")
    if audit.get("droppedImages") or audit.get("droppedFrames") or audit.get("errors"):
        raise ValueError("capture/probe dropped observations or reported errors")
    images, geometry = audit["images"], audit["frames"]
    if not images or not geometry:
        raise ValueError("capture has no images or geometry")
    stem = path.name.removesuffix(".transcript-layout.json")
    directory = path.parent / (stem + ".transcript-frames")
    dimensions = subprocess.check_output(
        ["magick", "identify", "-ping", "-format", "%w %h\n",
         *(str(directory / image["file"]) for image in images)], text=True).splitlines()
    if len(dimensions) != len(images) or any(value != "1440 1000" for value in dimensions):
        raise ValueError("reviewed masks require every captured image to be 1440x1000")
    width, height = 1440, 1000
    first = geometry[0]
    probe = audit.get("paintProbe")
    left = math.ceil(probe["left"] + 108) if probe else math.ceil(first["viewportLeft"] + 120)
    crop = (left, math.ceil(first["viewportTop"]), round(first["viewportRight"]), math.floor(first["viewportBottom"]))
    if not (0 <= crop[0] < crop[2] <= width and 0 <= crop[1] < crop[3] <= height):
        raise ValueError("transcript crop lies outside captured image")
    active_windows = windows(audit)
    samples = {sample["id"]: sample for sample in audit.get("samples", [])}
    calibration = None
    if probe:
        if (probe["width"], probe["height"]) != (width, height):
            raise ValueError("probe CSS dimensions differ from captured pixels")
        calibration = calibrate(audit, directory, probe, width, height)
    process = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-threads", "1", "-filter_threads", "1", "-i", str(directory / "frame-%04d.jpg"),
         "-frames:v", str(len(images)), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frames = []
    try:
        for index, image in enumerate(images):
            data = process.stdout.read(width * height)
            if len(data) != width * height:
                raise ValueError(f"incomplete JPEG sequence at {image['file']}")
            occupied, dark = [], 0
            for y in range(crop[1], crop[3]):
                row = data[y * width + crop[0]:y * width + crop[2]].translate(INK)
                for x0, y0, x1, y1 in MASKS:
                    if y0 <= y < y1:
                        start, end = max(0, x0 - crop[0]), min(crop[2] - crop[0], x1 - crop[0])
                        if end > start:
                            row = row[:start] + bytes(end - start) + row[end:]
                amount = row.count(1)
                dark += amount
                if amount > 4:
                    occupied.append(y)
            extent = occupied[-1] - occupied[0] + 1 if occupied else 0
            paint = "blank" if dark == 0 else "sparse" if extent < (crop[3] - crop[1]) * .55 or len(occupied) < (crop[3] - crop[1]) * .11 else "populated"
            at = image["timestamp"] * 1000 - audit["timeOrigin"]
            active = next((window for window in active_windows if window["startMs"] <= at < window["endMs"]), None)
            frame = {"index": index, "file": image["file"], "atMs": at, "active": bool(active),
                     "direction": active["direction"] if active else None, "class": paint,
                     "darkPixels": dark, "occupiedScanlines": len(occupied), "inkExtentRows": extent}
            if probe and paint == "blank":
                frame.update(attribute(data, audit, samples, calibration, crop, width, height, at))
            frames.append(frame)
        errors = process.stderr.read().decode()
        if process.wait():
            raise ValueError(errors.strip() or "JPEG decode failed")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    active = metrics([frame for frame in frames if frame["active"]])
    reasons = []
    if not active["captures"]:
        reasons.append("no captures in active trajectory")
    stat = path.stat()
    return {"version": VERSION, "classifierHash": classifier_hash, "sourceSignature": [stat.st_size, stat.st_mtime_ns],
            "source": str(path.resolve()), "stem": stem, "metadata": metadata, "valid": not reasons, "invalidReasons": reasons,
            "crop": crop, "masks": MASKS, "windows": active_windows, "active": active, "all": metrics(frames),
            "calibration": calibration,
            "initialBounce": initial_bounce(audit) if metadata.get("step", "").endswith("-scroll") else None,
            "causes": {key: sum(frame.get("cause") == key for frame in frames if frame["active"])
                       for key in LABELS} if probe else None,
            "directions": {direction: metrics([frame for frame in frames if frame["direction"] == direction]) for direction in ("up", "down")},
            "droppedImages": audit.get("droppedImages", 0), "droppedGeometry": audit.get("droppedFrames", 0),
            "captureErrors": audit.get("errors", []), "frames": frames}


def cell(metadata):
    return {key: metadata.get(key) for key in ("engine", "step", "configuration", "viewport", "networkProfile")}


def aggregate(records):
    pooled = collections.Counter()
    for record in records:
        pooled.update({key: record["active"][key] for key in CLASSES})
    fractions = [record["active"]["blankFraction"] for record in records]
    return {"observations": len(records), "pooled": totals(pooled),
            "blankFractionMedian": statistics.median(fractions) if fractions else None,
            "blankFractionMean": statistics.mean(fractions) if fractions else None,
            "blankFractions": fractions}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--expected-bundles", default="0,1,2")
    parser.add_argument("--baseline", type=int, default=0)
    args = parser.parse_args()
    expected = {int(value) for value in args.expected_bundles.split(",")}
    if args.baseline not in expected:
        parser.error("--baseline must be included in --expected-bundles")
    if args.source.resolve() == args.output.resolve():
        parser.error("output must differ from source to preserve benchmark JSON")
    classifier_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    metadata = {item["artifactPrefix"]: item for line in (args.source / "observations.jsonl").read_text().splitlines()
                if (item := json.loads(line))}
    args.output.mkdir(parents=True, exist_ok=True)
    observations, failures = [], []
    for stem in metadata:
        if not (args.source / (stem + ".transcript-layout.json")).exists():
            failures.append({"stem": stem, "error": "observation has no transcript layout audit"})
    for path in sorted(args.source.glob("*.transcript-layout.json")):
        stem = path.name.removesuffix(".transcript-layout.json")
        target = args.output / (stem + ".json")
        try:
            record = classify(path, metadata.get(stem, {}), classifier_hash)
            target.write_text(json.dumps(record, indent=2))
            observations.append(record)
            print(json.dumps({"stem": stem, "valid": record["valid"], **record["active"]}), flush=True)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            failures.append({"stem": stem, "error": str(error)})
            print(json.dumps(failures[-1]), flush=True)
    arm_groups, pair_groups = {}, {}
    for record in observations:
        if not record["valid"]:
            continue
        meta = record["metadata"]
        key = json.dumps(cell(meta), sort_keys=True)
        arm_groups.setdefault((key, meta["bundle"]), []).append(record)
        pair_groups.setdefault((key, meta["pair"]), {}).setdefault(meta["bundle"], []).append(record)
    arms = [{"cell": json.loads(key), "bundle": bundle, **aggregate(records)}
            for (key, bundle), records in arm_groups.items()]
    pairs, matched_groups = [], {}
    for (key, pair), members in pair_groups.items():
        complete = expected <= members.keys() and all(len(records) == 1 for records in members.values())
        comparisons = []
        if complete and args.baseline in members:
            for bundle in expected:
                matched_groups.setdefault((key, bundle), []).extend(members[bundle])
            base = members[args.baseline][0]["active"]["blankFraction"]
            for bundle in sorted(expected - {args.baseline}):
                fraction = members[bundle][0]["active"]["blankFraction"]
                comparisons.append({"bundle": bundle, "baseline": args.baseline, "blankFractionDelta": fraction - base,
                                    "blankFractionRelativeChange": fraction / base - 1 if base else None})
        pairs.append({"cell": json.loads(key), "pair": pair, "complete": complete,
                      "arms": {str(bundle): [{"stem": record["stem"], **record["active"]} for record in records] for bundle, records in members.items()},
                      "comparisons": comparisons})
    summary = {"version": VERSION, "classifierHash": classifier_hash, "notes": NOTES + CAVEATS, "labels": LABELS, "expectedBundles": sorted(expected),
               "observations": [{key: value for key, value in record.items() if key != "frames"} for record in observations],
               "arms": arms, "matchedArms": [{"cell": json.loads(key), "bundle": bundle, **aggregate(records)}
                                              for (key, bundle), records in matched_groups.items()],
               "pairs": pairs, "failures": failures}
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({"observations": len(observations), "valid": sum(record["valid"] for record in observations),
                      "completePairs": sum(pair["complete"] for pair in pairs), "failures": failures}), flush=True)
    return 1 if not observations or failures or any(not record["valid"] for record in observations) else 0


if __name__ == "__main__":
    raise SystemExit(main())
