#!/usr/bin/env python3
"""Prospective comparison for the temporary signed compilation-cache qualification.

Usage: python3 -B scripts/ios-archive-cache-compare.py BASELINE CANDIDATE --output FILE
Add --negative-controls to exercise copied-resource mutations after a positive pair.
Only the recorded appearance permutation, NLU clock field, and exact SDK aliases
are allowed. Unknown bytes/records fail. This does not revise the older campaign.
"""
import argparse
import ctypes as ct
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("cache_assets", HERE / "ios-archive-cache-assets.py")
ASSETS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASSETS)
CATALOGS = {"Payload/OpenClaw.app/Assets.car",
            "Payload/OpenClaw.app/Watch/OpenClawWatchApp.app/Assets.car"}
NLU = re.compile(r"Payload/OpenClaw\.app/[A-Za-z0-9_-]+\.lproj/nlu\.appintents/nlu\.lzfse")
SYMBOLS = re.compile(r"Symbols/[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\.symbols")
SANDBOX = "(version 1)(allow default)(deny file-write*)(deny mach-lookup)"
SYMBOL_FIELDS = ["uuid", "symbolCount", "sourceInfoCount", "deduplicatedSymbolCount",
                 "deduplicatedVariantCount", "symbolTableSha256", "deduplicatedVariantsSha256",
                 "sourceTableSdkAliasNormalizedSha256", "boundaryAddressCount",
                 "boundaryAddressesSha256", "nonemptyQueries", "queriesWithInlineChains",
                 "maxChainDepth", "boundaryInlineResultsSdkAliasNormalizedSha256"]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load(file):
    return json.loads(file.read_text())


def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, indent=2) + "\n")


def command(args):
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout.strip()


def decoder_tools():
    developer = Path(os.environ.get("DEVELOPER_DIR") or command(["xcode-select", "-p"])).resolve()
    require(developer.name == "Developer" and developer.parent.name == "Contents",
            "Selected toolchain is not a full Xcode developer directory")
    resources = developer.parent / "SharedFrameworks/CoreSymbolicationDT.framework/Resources"
    files = [resources / name for name in ["libatos/libs/libatos.dylib", "libatos/libatos.py",
                                         "libatos/types/types.py"]]
    require(all(file.is_file() for file in files), "Selected Xcode lacks the diagnostic decoder")
    return {"xcode": command(["xcodebuild", "-version"]), "resources": str(resources),
            "python": sys.version, "macOS": platform.mac_ver()[0],
            "architecture": platform.machine(), "sandbox": SANDBOX,
            "fingerprints": {str(file.relative_to(resources)): sha(file.read_bytes()) for file in files},
            "helperSha256": sha((HERE / "ios-archive-cache-symbols.py").read_bytes()),
            "limitation": "Private Apple APIs; exposed range-boundary inline queries, not every instruction or undocumented binary field"}


def decode_symbols(file, tools):
    result = subprocess.run(["/usr/bin/sandbox-exec", "-p", SANDBOX, sys.executable, "-B",
                             str(HERE / "ios-archive-cache-symbols.py"), str(file),
                             "--resources", tools["resources"]], capture_output=True, text=True,
                            timeout=180)
    require(result.returncode == 0 and not result.stderr,
            f"Symbol decoding failed ({result.returncode}): {result.stderr[-2000:]}")
    return json.loads(result.stdout)


def compression(data, encode=False):
    library = ct.CDLL("/usr/lib/libcompression.dylib")
    fn = library.compression_encode_buffer if encode else library.compression_decode_buffer
    fn.argtypes = [ct.c_void_p, ct.c_size_t, ct.c_void_p, ct.c_size_t, ct.c_void_p, ct.c_int]
    fn.restype = ct.c_size_t
    source = ct.create_string_buffer(data)
    for size in [65536, 1048576, 16777216]:
        output = ct.create_string_buffer(size)
        length = fn(output, size, source, len(data), None, 0x801)
        if length:
            return output.raw[:length]
    raise ValueError("LZFSE conversion failed or exceeded diagnostic size budget")


def compare_nlu(a, b, baseline, candidate):
    left, right = compression(a), compression(b)
    require(len(left) == len(right) and len(left) >= 64, "NLU decompressed size changed")
    offset = len(left) - 64
    require(left[:offset] == right[:offset] and left[offset + 8:] == right[offset + 8:],
            "NLU bytes outside generation-time field changed")
    timestamps = []
    for data, summary in [(left, baseline), (right, candidate)]:
        value = int.from_bytes(data[offset:offset + 8], "little")
        lower = int(datetime.fromisoformat(summary["startedAt"].replace("Z", "+00:00")).timestamp())
        upper = int(datetime.fromisoformat(summary["finishedAt"].replace("Z", "+00:00")).timestamp())
        require(lower <= value <= upper, "NLU generation-time field is outside its archive interval")
        timestamps.append(value)
    return {"fieldOffset": offset, "decompressedBytes": len(left), "generationTimes": timestamps,
            "allOtherDecompressedBytesExact": True}


def retained_file(directory, name, manifest):
    file = directory / "generated-resources" / name
    require(file.is_file() and not file.is_symlink(), f"Missing regular retained resource: {name}")
    data = file.read_bytes()
    require(sha(data) == manifest[name]["sha256"], f"Retained resource does not match manifest: {name}")
    return data


def compare_cases(baseline_dir, candidate_dir):
    baseline, candidate = load(baseline_dir / "summary.json"), load(candidate_dir / "summary.json")
    left, right = baseline["payload"], candidate["payload"]
    require(left["info"] == right["info"], "Exported metadata changed")
    require(left["signatures"] == right["signatures"], "Signing identities/entitlements/UUIDs changed")
    a, b = left["manifest"], right["manifest"]
    require(a.keys() == b.keys(), "Exported manifest path set changed")
    changed = []
    for name in sorted(a):
        require({k: v for k, v in a[name].items() if k != "sha256"} ==
                {k: v for k, v in b[name].items() if k != "sha256"}, f"File mode/type/symlink changed: {name}")
        if a[name] != b[name]:
            require(name in CATALOGS or NLU.fullmatch(name) or SYMBOLS.fullmatch(name),
                    f"Unexpected content difference: {name}")
            changed.append(name)
    # The retained files are evidence for manifest hashes, not a separate owner.
    for directory, manifest in [(baseline_dir, a), (candidate_dir, b)]:
        for name in manifest:
            if name in CATALOGS or NLU.fullmatch(name) or SYMBOLS.fullmatch(name):
                retained_file(directory, name, manifest)
    expected_symbols = {"Symbols/" + item.split(":", 1)[1] + ".symbols"
                        for signature in left["signatures"].values()
                        for item in signature["executableUuids"]}
    require({name for name in a if name.startswith("Symbols/")} == expected_symbols,
            "Exported symbols do not match executable UUID inventory")
    result = {"accepted": True, "changedFiles": changed,
              "metadataExact": True, "signaturesExact": True, "manifestPathsAndModesExact": True,
              "exactFileCount": len(a) - len(changed), "allowedComparisons": []}
    tools = decoder_tools() if any(SYMBOLS.fullmatch(name) for name in changed) else None
    if tools:
        result["symbolDecoder"] = tools
    for name in changed:
        data_a = retained_file(baseline_dir, name, a)
        data_b = retained_file(candidate_dir, name, b)
        if name in CATALOGS:
            value = {"rule": "appearance-record-permutation", **ASSETS.compare(data_a, data_b)}
        elif NLU.fullmatch(name):
            value = {"rule": "observed-nlu-generation-time-field",
                     **compare_nlu(data_a, data_b, baseline, candidate)}
        else:
            decoded_a = decode_symbols(baseline_dir / "generated-resources" / name, tools)
            decoded_b = decode_symbols(candidate_dir / "generated-resources" / name, tools)
            mismatches = [field for field in SYMBOL_FIELDS if decoded_a[field] != decoded_b[field]]
            require(not mismatches, f"Symbol/source/inline mapping changed: {name}: {mismatches}")
            value = {"rule": "native-symbol-source-tables-and-inline-boundaries",
                     "comparedFields": SYMBOL_FIELDS, "baseline": decoded_a, "candidate": decoded_b}
        result["allowedComparisons"].append({"path": name, **value})
    return result


def negative_controls(baseline_dir, candidate_dir):
    original = load(candidate_dir / "summary.json")
    catalog = "Payload/OpenClaw.app/Assets.car"
    nlu = next(name for name in original["payload"]["manifest"] if NLU.fullmatch(name))
    widget_uuid = original["payload"]["signatures"]["PlugIns/OpenClawActivityWidget.appex"]["executableUuids"][0].split(":")[1]
    widget = f"Symbols/{widget_uuid}.symbols"
    results = []
    mutations = ["rendition-data", "appearance-value", "nlu-non-timestamp", "symbol-source-filename",
                 "file-mode", "executable-content"]
    reasons = {
        "rendition-data": "Unexplained bytes outside appearance permutation",
        "appearance-value": "Appearance mapping changed",
        "nlu-non-timestamp": "NLU bytes outside generation-time field changed",
        "symbol-source-filename": "Symbol/source/inline mapping changed:",
        "file-mode": "File mode/type/symlink changed:",
        "executable-content": "Unexpected content difference:",
    }
    for mutation in mutations:
        with tempfile.TemporaryDirectory(prefix="ios-cache-negative-") as temp:
            copied = Path(temp) / "candidate"
            copied.mkdir()
            summary = json.loads(json.dumps(original))
            manifest = summary["payload"]["manifest"]
            shutil.copytree(candidate_dir / "generated-resources", copied / "generated-resources")
            name, mutated = None, None
            if mutation in ["rendition-data", "appearance-value"]:
                name = catalog
                data = bytearray((copied / "generated-resources" / name).read_bytes())
                blocks, _, _, _, entries = ASSETS.bom(data)
                if mutation == "rendition-data":
                    offset, size = max(blocks, key=lambda block: block[1])
                    data[offset + size // 2] ^= 1
                else:
                    offset, _ = blocks[entries[0]["value_id"]]
                    data[offset] ^= 1
                mutated = bytes(data)
            elif mutation == "nlu-non-timestamp":
                name = nlu
                data = bytearray(compression((copied / "generated-resources" / name).read_bytes()))
                data[0] ^= 1
                mutated = compression(bytes(data), encode=True)
            elif mutation == "symbol-source-filename":
                name = widget
                data = (copied / "generated-resources" / name).read_bytes()
                require(data.count(b"LibcShims.h") == 1, "Negative control requires one known source string")
                mutated = data.replace(b"LibcShims.h", b"LibcShims.x")
            elif mutation == "file-mode":
                manifest[catalog]["mode"] ^= 1
            else:
                name = "Payload/OpenClaw.app/OpenClaw"
                manifest[name]["sha256"] = "0" * 64
            if mutated is not None:
                (copied / "generated-resources" / name).write_bytes(mutated)
                manifest[name]["sha256"] = sha(mutated)
            save(copied / "summary.json", summary)
            try:
                compare_cases(baseline_dir, copied)
            except ValueError as error:
                require(str(error).startswith(reasons[mutation]),
                        f"Negative control failed at the wrong boundary: {mutation}: {error}")
                results.append({"mutation": mutation, "rejected": True, "reason": str(error)})
            else:
                raise ValueError(f"Negative control accepted: {mutation}")
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--negative-controls", action="store_true")
    args = parser.parse_args()
    try:
        result = compare_cases(args.baseline.resolve(), args.candidate.resolve())
        if args.negative_controls:
            result["negativeControls"] = negative_controls(args.baseline.resolve(), args.candidate.resolve())
            result["negativeControlsPassed"] = True
    except Exception as error:
        result = {"accepted": False, "error": str(error), "errorType": type(error).__name__}
    save(args.output, result)
    print(json.dumps({key: result[key] for key in ["accepted", "changedFiles", "error"] if key in result}))
    return 0 if result["accepted"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
