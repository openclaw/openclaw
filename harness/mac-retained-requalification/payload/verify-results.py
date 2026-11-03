#!/usr/bin/env python3
"""Reject missing/duplicate/blank native PNGs and incomplete Swift runs."""
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import zlib
from reference_consumer import ReferenceArtifact, sealed_root, external_output
from png_codec import decode_png, mask as encoded_mask

def png_pixels(file, size, region=None, include_mask=False):
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
    light, masks = 0, []
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
        mask = ""
        for x in range(0, stride, channels):
            rgb = bytes(row[x:x+3])
            if len(colors) < 1024:
                colors.add(rgb)
            opaque = channels == 3 or row[x+3] > 128
            if min(rgb) > 200 and opaque:
                light += 1
            if include_mask:
                mask += "1" if max(rgb) < 180 and opaque else "0"
            if min(rgb) < 220 and opaque:
                nonwhite += 1
        if include_mask:
            masks.append(mask)
        previous = row
    assert len(colors) >= 16 and nonwhite >= 100, (file, "blank or nearly blank PNG")
    return {"width": width, "height": height, "sha256": hashlib.sha256(data).hexdigest(),
            "pixelSha256": pixel_hash.hexdigest(), "sampledColors": len(colors), "darkPixels": nonwhite,
            "regionPixelSha256": region_hash.hexdigest() if region is not None else None,
            "lightFraction": light/(width*height), "darkMask": masks if include_mask else None}

def contains(outer, inner):
    return (math.floor(outer["x"]) <= math.floor(inner["x"]) and
            math.floor(outer["y"]) <= math.floor(inner["y"]) and
            math.ceil(inner["x"]+inner["width"]) <= math.ceil(outer["x"]+outer["width"]) and
            math.ceil(inner["y"]+inner["height"]) <= math.ceil(outer["y"]+outer["height"]))

PINS = json.loads((Path(__file__).parent/'SOURCE-PINS.json').read_text())
ASSEMBLY = PINS['captureAssembly']
TEST_PATH = 'apps/macos/Tests/OpenClawIPCTests/OnboardingAISetupTests.swift'

def selected_function(functions, which):
    assert which == 'capture'
    name = 'nativeBrandedCopyPageCapture()'
    suite = 'LlamaNativeCaptureTests'
    selected = [key for key,value in functions.items() if value['name'] == name and key.startswith(f'OpenClawIPCTests.{suite}/{name}/') and value['sourceLocation']['fileID'] == 'OpenClawIPCTests/OnboardingAISetupTests.swift']
    assert len(selected) == 1, (which, selected, list(functions))
    return selected[0]

def literal_filter(identifier):
    # Swift Regex runtime strings use these metacharacters. Spaces, slashes,
    # backticks and colons remain literal; never shell-evaluate the result.
    special = chr(92)+'.^$|?*+()[]{}'
    return '^'+''.join(chr(92)+c if c in special else c for c in identifier)+'$'

def discovery(root, stage):
    assert stage in ('before','after')
    assert int((root/f'discovery-{stage}-exit.txt').read_text()) == 0
    assert (root/f'overlaid-{stage}.sha256').read_text().split()[0] == ASSEMBLY['effectiveTestFileSha256BothStages']
    path = root/f'discovery-events-{stage}.jsonl'
    records = [json.loads(line) for line in path.read_text().splitlines()]
    functions = {}
    for record in records:
        if record.get('kind') in ('event','test'):
            assert record['version'] == '6.3.0', record
        if record.get('kind') == 'event':
            assert record['payload']['kind'] not in ('runStarted','runEnded','testStarted','testEnded','testCaseStarted','testCaseEnded','testSkipped','testCancelled','issueRecorded'), record
        if record.get('kind') == 'test' and record['payload'].get('kind') == 'function':
            value = record['payload']; key = value['id']
            assert key not in functions, ('Duplicate discovered function',key)
            functions[key] = value
    selected = {}
    for which in ('capture',):
        identifier = selected_function(functions,which)
        selected[which] = {'id':identifier,'name':functions[identifier]['name'],'filter':literal_filter(identifier)}
    return {'stage':stage,'mode':'listing-only; no test execution events','discoverySha256':hashlib.sha256(path.read_bytes()).hexdigest(),'discoveredFunctions':len(functions),'selected':selected}

def events(root, stage, which):
    assert stage in ('before', 'after') and which == 'capture'
    records = [json.loads(line) for line in (root/f'{which}-events-{stage}.jsonl').read_text().splitlines()]
    functions = {r['payload']['id']:r['payload'] for r in records if r.get('kind') == 'test' and r['payload'].get('kind') == 'function'}
    target = selected_function(functions,which)
    assert target == discovery(root,stage)['selected'][which]['id'], 'Execution differs from exact listing admission'
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
    expected = []
    assert sorted(issues) == sorted(expected), (issues, expected)
    code = int((root/f'{which}-{stage}-exit.txt').read_text())
    assert code == 0, (stage, which, code)
    return {'stage':stage, 'kind':which, 'selectedFunctionID':target, 'discoveredFunctions':len(functions), 'completedSelectedFunctions':1, 'issueLines':issues, 'exit':code}

def reference_mask(record, scale):
    contract = PINS['brandPixelContract']
    size = int(contract['wellPoints']*scale)
    assert (record['width'],record['height']) == (size,size)
    assert record['pointSize'] == contract['wellPoints'] and record['darkThreshold'] == contract['darkThreshold']
    rows = record['rows']
    assert len(rows) == size and all(len(row) == size and set(row) <= {'0','1'} for row in rows)
    dark = sum(row.count('1') for row in rows)
    assert dark == record['darkPixels'] and contract['minimumDarkPixels'] <= dark < size*size/2
    return rows

def best_glyph_match(page, reference, origin, tolerance):
    width,height = len(reference[0]),len(reference)
    expected = sum(row.count('1') for row in reference)
    best = {'dice':0.0,'pixelOrigin':None}
    for y in range(round(origin[1])-tolerance,round(origin[1])+tolerance+1):
        for x in range(round(origin[0])-tolerance,round(origin[0])+tolerance+1):
            if x < 0 or y < 0 or y+height > len(page) or x+width > len(page[0]):
                continue
            actual,intersection = 0,0
            for dy,ref in enumerate(reference):
                row = page[y+dy][x:x+width]
                actual += row.count('1')
                intersection += sum(a == b == '1' for a,b in zip(row,ref))
            dice = 2*intersection/(actual+expected) if actual+expected else 0.0
            if dice > best['dice']:
                best = {'dice':dice,'pixelOrigin':[x,y]}
    return best

def branded_pixels(root, stage, ax, scale, page, reference_artifact):
    proof = json.loads((root/stage/'brand-proof.json').read_text())
    assert proof['appearance'] == 'light' and proof['llamaCppBorrowsAppMark'] is False
    assert set(proof['brands']) == {'llama-app','ollama'}
    refs = {'fallback':reference_mask(proof['fallback'],scale)}
    for brand in ('llama-app','ollama'):
        asset = proof['brands'][brand]
        expected = PINS['brandingSources'][brand]
        assert asset['assetSha256'] == expected['sha256']
        assert asset['resource'] == Path(expected['path']).name
        assert asset['decodedNativeImage'] is True and asset['isTemplate'] is True
        assert asset['imageSize']['width'] > 0 and asset['imageSize']['height'] > 0
        refs[brand] = reference_mask(asset['mask'],scale)
    # Old producer records remain mandatory native/source checks, not numeric references.
    refs = reference_artifact.masks(root/stage/'onboarding.png',stage,scale)
    fixture = json.loads((root/'copy-detect.json').read_text())
    screen = ax['capture']['screenBounds']; contract = PINS['brandPixelContract']
    matches = []
    for choice in fixture['prepareOptions']:
        brand = choice['brandId']
        action = choice.get('actionLabel', 'Set up' if stage == 'after' else 'Connect / Set up')
        full = choice['label']+', '+choice['hint']+', '+action
        controls = [c for c in ax['controls'] if c['role'] == 'AXButton' and full in c['labels']]
        assert len(controls) == 1, (stage,brand,'one exact branded row required')
        row = controls[0]['screenFrame']; size = contract['wellPoints']
        well = {'x':row['x']+contract['rowLeadingPaddingPoints'],'y':row['y']+(row['height']-size)/2,'width':size,'height':size}
        assert contains(row,well) and contains(screen,well)
        origin = ((well['x']-screen['x'])*scale,(screen['y']+screen['height']-well['y']-size)*scale)
        assert origin == reference_artifact.origin(stage,brand), 'Reference geometry differs from full captured AX row'
        scores = {name:best_glyph_match(page,ref,origin,math.ceil(contract['positionTolerancePoints']*scale)) for name,ref in refs.items()}
        expected = scores[brand]['dice']
        other = max(v['dice'] for name,v in scores.items() if name != brand)
        assert expected >= contract['minimumDice'], (stage,brand,'native mark missing/misrendered',scores)
        assert expected-other >= contract['minimumWinningMargin'], (stage,brand,'generic/wrong glyph wins',scores)
        matches.append({'brandId':brand,'assetSha256':PINS['brandingSources'][brand]['sha256'],'sourceBoundWell':well,'scores':scores})
    assert {m['brandId'] for m in matches} == {'llama-app','ollama'}
    return matches

def freeze(root, name, stage):
    manifest = root/(name+'.jsonl')
    receipt = json.loads((root/(name+'-receipt.json')).read_text())
    expected = (PINS['baseCommit'], PINS['baseTree']) if stage == 'before' else (PINS['afterCommit'], PINS['effectiveCandidateTree'])
    assert (receipt['commit'],receipt['tree']) == expected and receipt['stage'] == stage
    assert receipt['manifestSha256'] == hashlib.sha256(manifest.read_bytes()).hexdigest()
    rows = [json.loads(line) for line in manifest.read_text().splitlines()]
    assert len(rows) == receipt['matchedBlobs'] and len({r['path'] for r in rows}) == len(rows)
    return {r['path']:(r['mode'], r['gitBlob'], r['sha256']) for r in rows}

def all_results(root, reference_artifact, output):
    output = external_output(output,root,reference_artifact.root)
    sealed_root(root,PINS['retainedReferenceConsumer']['originalArtifactSealSha256'],70)
    assert not list(root.glob('mounted-events-*')), 'Capture-only packet must not rerun mounted regression'
    fixture = json.loads((root/'copy-detect.json').read_text())
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
    for item in PINS['brandingSources'].values():
        assert freezes['before'][item['path']][2] == freezes['after'][item['path']][2] == item['sha256']
    rows=[]; tests=[]
    for stage in ('before','after'):
        assert freeze(root,'build-source-'+stage,stage) == freezes[stage]
        assert (root/f'overlaid-{stage}.sha256').read_text().split()[0] == ASSEMBLY['effectiveTestFileSha256BothStages']
        for which in ('capture',):
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
        assert (receipt['intro'],receipt['fallbackAction'],receipt['suppliedAction']) == (intro,fallback,'Set up')
        assert receipt['executedMountedRegression'] is False
        ax=json.loads((folder/'onboarding.accessibility.json').read_text())
        app,ollama = fixture['prepareOptions']
        assert [(r['id'],r['brandId']) for r in [app,ollama]] == [('llama-app','llama-app'),('ollama','ollama')]
        assert 'actionLabel' not in app and ollama['actionLabel'] == 'Set up'
        required=['Connect your AI','Set up a local model',intro,app['label'],app['hint'],fallback,ollama['label'],ollama['hint'],'Set up']
        capture=ax['capture']; bounds=capture['bounds']; screen=capture['screenBounds']; scale=capture['backingScaleFactor']
        assert scale in (1,2) and (bounds['width'],bounds['height']) == (630,1000)
        assert (screen['width'],screen['height']) == (bounds['width'],bounds['height'])
        size=(math.ceil(bounds['width']*scale),math.ceil(bounds['height']*scale))
        assert size == (capture['rasterSize']['width'],capture['rasterSize']['height'])
        for label in required:
            assert any(label in s for s in ax['labels']), (stage,label)
            assert any(any(label in s for s in node['labels']) and contains(screen,node['screenFrame']) for node in ax['nodes']), (stage,label,'clipped')
        assert ax['controls'] and all(contains(screen,node['screenFrame']) for node in ax['controls'])
        for action in [app['label']+', '+app['hint']+', '+fallback,ollama['label']+', '+ollama['hint']+', Set up']:
            assert ax['actions'][action] is True, (stage,action)
        decoded = png_pixels(folder/'onboarding.png',size,include_mask=True)
        assert decoded['lightFraction'] >= PINS['brandPixelContract']['minimumLightFraction']
        mask = decoded.pop('darkMask')
        # Both sides use the same encoded PNG decoder and profile-bound threshold.
        assert mask == encoded_mask(decode_png(folder/'onboarding.png')['rows'])
        matches = branded_pixels(root,stage,ax,scale,mask,reference_artifact)
        rows.append({'stage':stage,'logicalBounds':bounds,'brandMatches':matches,**decoded})
    assert (rows[0]['width'],rows[0]['height']) == (rows[1]['width'],rows[1]['height'])
    assert rows[0]['pixelSha256'] != rows[1]['pixelSha256'], 'Before/After copy pixels did not change'
    assert sorted(str(p.relative_to(root)) for p in root.rglob('*.png')) == ['after/onboarding.png','before/onboarding.png']
    output.write_text(json.dumps({'status':'REQUALIFIED_RETAINED_CAPTURES_NOT_NEW_CAPTURE','originalRunRemainsFailed':41572287535,'referenceArtifact':reference_artifact.pins,'requiresParentFullResolutionInspectionAndDelivery':True,'tests':tests,'frames':rows},indent=2)+'\n')

if __name__ == '__main__':
    mode=sys.argv[1]; root=Path(sys.argv[2])
    if mode == 'discovery':
        print(json.dumps(discovery(root,sys.argv[3]),indent=2))
    elif mode == 'selector':
        print(discovery(root,sys.argv[3])['selected'][sys.argv[4]]['filter'])
    elif mode == 'events':
        print(json.dumps(events(root,sys.argv[3],sys.argv[4])))
    elif mode == 'all':
        assert len(sys.argv) == 5, 'all requires exact reference artifact root and NEW external receipt path'
        output = external_output(Path(sys.argv[4]),root,Path(sys.argv[3]))
        reference = ReferenceArtifact(Path(sys.argv[3]))
        all_results(root,reference,output)
    else:
        raise ValueError(mode)
