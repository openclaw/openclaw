#!/usr/bin/env python3
"""Reject missing/duplicate/blank native PNGs and incomplete Swift runs."""
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import zlib

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

def contains(outer, inner):
    return (math.floor(outer["x"]) <= math.floor(inner["x"]) and
            math.floor(outer["y"]) <= math.floor(inner["y"]) and
            math.ceil(inner["x"]+inner["width"]) <= math.ceil(outer["x"]+outer["width"]) and
            math.ceil(inner["y"]+inner["height"]) <= math.ceil(outer["y"]+outer["height"]))

PINS = json.loads((Path(__file__).parent/'SOURCE-PINS.json').read_text())
ASSEMBLY = PINS['captureAssembly']
TEST_PATH = 'apps/macos/Tests/OpenClawIPCTests/OnboardingAISetupTests.swift'

def events(root, stage, which):
    assert stage in ('before', 'after') and which in ('mounted', 'capture')
    records = [json.loads(line) for line in (root/f'{which}-events-{stage}.jsonl').read_text().splitlines()]
    name = ('prepare rows use plain copy and preserve wire actions()' if which == 'mounted' else 'nativePlainCopyPageCapture()')
    suite = 'OnboardingAISetupTests' if which == 'mounted' else 'LlamaNativeCaptureTests'
    functions = {r['payload']['id']:r['payload'] for r in records if r.get('kind') == 'test' and r['payload'].get('kind') == 'function'}
    # Swift Testing IDs include a source-location suffix. Resolve ONE exact ID
    # from the exact function name/owning suite/file, never count its whole suite.
    selected = [key for key,value in functions.items() if value['name'] == name and key.startswith(f'OpenClawIPCTests.{suite}/{name}/') and value['sourceLocation']['fileID'] == 'OpenClawIPCTests/OnboardingAISetupTests.swift']
    assert len(selected) == 1, (selected, list(functions))
    target = selected[0]
    phases, starts, ends, issues = [], [], [], []
    selected_started = False
    for record in records:
        if record.get('kind') not in ('event', 'test'):
            continue
        assert record['version'] == '6.3.0', record
        if record['kind'] != 'event':
            continue
        event = record['payload']; kind = event['kind']; test = event.get('testID')
        if kind in ('runStarted', 'runEnded'):
            phases.append(kind)
        if kind in ('testStarted', 'testEnded') and test in functions:
            assert test == target, ('Unselected function executed', test)
            if kind == 'testStarted':
                assert not selected_started and not starts and not ends
                selected_started = True; starts.append(test)
            else:
                assert selected_started and not ends
                selected_started = False; ends.append(test)
        if kind in ('testSkipped', 'testCancelled'):
            assert test != target, event
        if kind == 'issueRecorded':
            assert test == target and selected_started, event
            issue = event['issue']
            assert issue['isKnown'] is False and issue['isFailure'] is True and issue['severity'] == 'error', issue
            location = issue['sourceLocation']
            assert location['fileID'] == 'OpenClawIPCTests/OnboardingAISetupTests.swift', location
            issues.append(location['line'])
    assert phases == ['runStarted', 'runEnded'] and starts == ends == [target]
    expected = ASSEMBLY['expectedBeforeIssueLines'] if stage == 'before' and which == 'mounted' else []
    assert sorted(issues) == sorted(expected), (issues, expected)
    code = int((root/f'{which}-{stage}-exit.txt').read_text())
    assert (code != 0) if expected else (code == 0), (stage, which, code)
    return {'stage':stage, 'kind':which, 'selectedFunctionID':target, 'discoveredFunctions':len(functions), 'completedSelectedFunctions':1, 'issueLines':issues, 'exit':code}

def freeze(root, name, stage):
    manifest = root/(name+'.jsonl')
    receipt = json.loads((root/(name+'-receipt.json')).read_text())
    expected = (PINS['baseCommit'], PINS['baseTree']) if stage == 'before' else (PINS['afterCommit'], PINS['effectiveCandidateTree'])
    assert (receipt['commit'],receipt['tree']) == expected and receipt['stage'] == stage
    assert receipt['manifestSha256'] == hashlib.sha256(manifest.read_bytes()).hexdigest()
    rows = [json.loads(line) for line in manifest.read_text().splitlines()]
    assert len(rows) == receipt['matchedBlobs'] and len({r['path'] for r in rows}) == len(rows)
    return {r['path']:(r['mode'], r['gitBlob'], r['sha256']) for r in rows}

def all_results(root):
    assert hashlib.sha256((root/'copy-detect.json').read_bytes()).hexdigest() == PINS['fixture']['sha256']
    assert json.loads((root/'fixture-validation.json').read_text())['status'] == 'PASS'
    assert hashlib.sha256((root/'after-tests.swift').read_bytes()).hexdigest() == PINS['authoredFiles'][1]['afterSha256']
    helper=(root/'qualified-helper.swift.append').read_bytes(); append=(root/'copy-helper.swift.append').read_bytes()
    assert hashlib.sha256(helper).hexdigest() == ASSEMBLY['qualifiedAdcHelperSha256']
    assert hashlib.sha256(append).hexdigest() == ASSEMBLY['copyAppendSha256']
    assert hashlib.sha256((root/'after-tests.swift').read_bytes()+helper+append).hexdigest() == ASSEMBLY['effectiveTestFileSha256BothStages']
    freezes={stage:freeze(root,'source-'+stage,stage) for stage in ('before','after')}
    changed={p for p in freezes['before'].keys() | freezes['after'].keys() if freezes['before'].get(p) != freezes['after'].get(p)}
    assert changed == set(PINS['effectiveChangedPaths'])
    assert freeze(root,'final-source-after','after') == freezes['after']
    assert freezes['after'][PINS['generatedCompanion']['path']][2] == PINS['generatedCompanion']['afterSha256']
    for f in PINS['authoredFiles']:
        assert freezes['before'][f['path']][2] == f['beforeSha256'] and freezes['after'][f['path']][2] == f['afterSha256']
    rows=[]; tests=[]
    for stage in ('before','after'):
        assert freeze(root,'build-source-'+stage,stage) == freezes[stage]
        assert (root/f'overlaid-{stage}.sha256').read_text().split()[0] == ASSEMBLY['effectiveTestFileSha256BothStages']
        for which in ('mounted','capture'):
            tests.append(events(root,stage,which))
        folder=root/stage
        assert sorted(p.name for p in folder.glob('*.png')) == ['onboarding.png']
        receipt=json.loads((folder/'receipt.json').read_text())
        intro=('Choose an option below to connect or set up local AI.' if stage == 'after' else 'Connect a local model service, or prepare a model on this Gateway.')
        fallback='Set up' if stage == 'after' else 'Connect / Set up'
        assert receipt['stage'] == stage and receipt['locale'] == 'en_US' and receipt['appearance'] == 'light'
        assert receipt['requests'] == ['openclaw.setup.detect'] and receipt['activated'] is False and receipt['inferenceAttempted'] is False and receipt['selectedKind'] is None
        assert receipt['fixtureSha256'] == PINS['fixture']['sha256']
        assert receipt['sourceTree'] == (PINS['baseTree'] if stage == 'before' else PINS['effectiveCandidateTree'])
        assert (receipt['intro'],receipt['fallbackAction'],receipt['customAction']) == (intro,fallback,'Provider-owned action')
        ax=json.loads((folder/'onboarding.accessibility.json').read_text())
        required=['Connect your AI','Set up a local model',intro,'Fallback local app','Supplied fallback hint',fallback,'Custom local app','Supplied custom hint','Provider-owned action']
        capture=ax['capture']; bounds=capture['bounds']; screen=capture['screenBounds']; scale=capture['backingScaleFactor']
        assert scale in (1,2) and (bounds['width'],bounds['height']) == (630,1000)
        assert (screen['width'],screen['height']) == (bounds['width'],bounds['height'])
        size=(math.ceil(bounds['width']*scale),math.ceil(bounds['height']*scale))
        assert size == (capture['rasterSize']['width'],capture['rasterSize']['height'])
        for label in required:
            assert any(label in s for s in ax['labels']), (stage,label)
            assert any(any(label in s for s in node['labels']) and contains(screen,node['screenFrame']) for node in ax['nodes']), (stage,label,'clipped')
        assert ax['controls'] and all(contains(screen,node['screenFrame']) for node in ax['controls'])
        for action in [f'Fallback local app, Supplied fallback hint, {fallback}','Custom local app, Supplied custom hint, Provider-owned action']:
            assert ax['actions'][action] is True, (stage,action)
        rows.append({'stage':stage,'logicalBounds':bounds,**png_pixels(folder/'onboarding.png',size)})
    assert (rows[0]['width'],rows[0]['height']) == (rows[1]['width'],rows[1]['height'])
    assert rows[0]['pixelSha256'] != rows[1]['pixelSha256'], 'Before/After copy pixels did not change'
    assert sorted(str(p.relative_to(root)) for p in root.rglob('*.png')) == ['after/onboarding.png','before/onboarding.png']
    (root/'pixel-validation.json').write_text(json.dumps({'status':'PASS','requiresParentFullResolutionInspectionAndDelivery':True,'tests':tests,'frames':rows},indent=2)+'\n')

def seal(root):
    paths=sorted(p for p in root.rglob('*') if p.is_file() and p.name != 'OUTPUT-SHA256SUMS')
    (root/'OUTPUT-SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(root).as_posix()+'\n' for p in paths))

if __name__ == '__main__':
    mode=sys.argv[1]; root=Path(sys.argv[2])
    if mode == 'events':
        print(json.dumps(events(root,sys.argv[3],sys.argv[4])))
    elif mode == 'all':
        all_results(root)
    elif mode == 'seal':
        seal(root)
    else:
        raise ValueError(mode)
