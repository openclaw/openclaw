"""Consume one immutable, independently rendered reference artifact, never masks from callers."""
import hashlib
import json
from pathlib import Path, PurePosixPath
from png_codec import decode_png, crop, mask

HERE = Path(__file__).parent

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def sealed_root(root, seal_sha, count):
    seal = root/'OUTPUT-SHA256SUMS'
    assert digest(seal) == seal_sha, 'Unexpected immutable artifact seal'
    members = {}
    for line in seal.read_text().splitlines():
        sha, name = line.split(None, 1)
        path = PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts and name not in members
        file = root/name
        assert file.is_file() and not file.is_symlink() and digest(file) == sha, name
        members[name] = sha
    assert len(members) == count
    assert {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()} == set(members) | {'OUTPUT-SHA256SUMS'}
    return members

def external_output(output, original, reference):
    output = output.resolve()
    assert not output.exists(), 'Require new external output'
    assert not any(output.is_relative_to(root.resolve()) for root in (original,reference)), 'Output must be outside both immutable artifact roots'
    return output

class ReferenceArtifact:
    def __init__(self, root):
        self.root = Path(root)
        self.pins = json.loads((HERE/'SOURCE-PINS.json').read_text())['retainedReferenceConsumer']
        sealed_root(self.root, self.pins['outputSealSha256'], 152)
        assert (self.root/'STATUS.txt').read_text().strip() == 'DIAGNOSTIC_COMPLETE_PARENT_REVIEW_REQUIRED_NOT_QUALIFICATION'
        assert (self.root/'pipeline-status.txt').read_text().strip() == 'worker=0 logger=0'
        assert digest(self.root/'PAYLOAD-SHA256SUMS') == self.pins['producerManifestSha256']
        self.input = self.root/'admitted-inputs'
        self.plan = json.loads((self.input/'diagnostic-plan.json').read_text())
        assert digest(self.input/'diagnostic-plan.json') == self.pins['planSha256']
        assert self.plan['predeclaredMinimalCandidate'] == self.pins['case'] == 'file-source-paint'
        self.index = json.loads((self.root/'native/reference-index.json').read_text())
        assert self.index['planSha256'] == self.pins['planSha256']
        analysis = json.loads((self.root/'native/diagnostic-analysis.json').read_text())
        assert analysis['baselineReproduced'] and analysis['noAutomaticCaseOrPhaseSelection']
        self.scenes = json.loads((self.input/'scenes.json').read_text())['scenes']
        self.references = {}
        for brand in ('llama-app','ollama'):
            record = next(r for r in self.index['records'] if r['brand'] == brand and r['case'] == self.pins['case'])
            assert record['loader'] == 'file' and record['sourcePaint'] is True
            assert record['requestedHalfPhase'] is False and record['plainButtonContext'] is False
            assert record['assetSha256'] == self.plan['assets'][brand]['sha256']
            assert digest(self.input/'assets'/self.plan['assets'][brand]['filename']) == record['assetSha256']
            self.references[brand] = self.decode_reference(brand+'/'+self.pins['case'], record['result'], record['wellOriginOnReferenceCanvas'])
        self.references['fallback'] = self.decode_reference('fallback', self.index['fallback'], (0,0))

    def decode_reference(self, folder, result, origin):
        assert result['backingScale'] == 1
        passes = result['passes']
        assert [p['pass'] for p in passes] == ['first','warm-repeat']
        decoded = []
        for entry in passes:
            image = decode_png(self.root/'native'/folder/(entry['pass']+'.png'))
            assert image['sha256'] == entry['pngSha256']
            assert (image['width'],image['height']) == (entry['pixelsWide'],entry['pixelsHigh'])
            assert image['profile']['sha256'] == self.pins['iccSha256']
            decoded.append((image,crop(image,*map(int,origin))))
        assert decoded[0][1] == decoded[1][1], 'Fixed first pass only; warm is a repeatability control'
        rows = mask(decoded[0][1])
        dark = sum(row.count('1') for row in rows)
        assert 10 <= dark < 32*32/2
        return {'rows':rows, 'profile':decoded[0][0]['profile'], 'pngSha256':decoded[0][0]['sha256'], 'origin':list(origin)}

    def masks(self, page_path, stage, scale):
        assert scale == 1, 'This immutable reference artifact qualifies its captured scale only'
        for name, sha in self.plan['retainedMembers'].items():
            if name.startswith(stage+'/'):
                assert digest(page_path.parent/name.split('/',1)[1]) == sha
        page = decode_png(page_path)
        profile = page['profile']
        assert profile and profile['sha256'] == self.pins['iccSha256']
        assert all(ref['profile']['transformSha256'] == profile['transformSha256'] for ref in self.references.values())
        return {brand:ref['rows'] for brand,ref in self.references.items()}

    def origin(self, stage, brand):
        scene = next(s for s in self.scenes if s['stage'] == stage)
        choice = next(c for c in scene['choices'] if c['brand'] == brand)
        return tuple(choice['wellPixelOrigin'])
