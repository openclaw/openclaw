#!/usr/bin/env python3
"""Verify pinned metadata before transfer, then exact ZIP and payload bytes."""
import hashlib, json, pathlib, sys, zipfile
RUN = 43150040714
ID = 13914013008
SOURCE = '6d306591d7373a89dd06f6258c0955708079030b'
CONTROLLER = 'e65f5176bf13a1ebfba28539e70b7c2d3566d459'
ZIP_SHA = 'e5ba16de7a98bd7570a5eff691548ae86d5a6819255bdcd0ed998c61dd22f0bd'
TAR_SHA = 'a60860733916c6991aa7e4c58c06ac6f25c94773b02e2299607ec107d85eb8ec'
def require(value, message):
    if not value: raise SystemExit(message)
def verify_metadata(data):
    require(data['id'] == ID and data['name'] == 'frv-mac-candidate-'+SOURCE, 'artifact identity mismatch')
    require(data['expired'] is False, 'artifact expired: stop; do not allocate a producer')
    require(data['workflow_run']['id'] == RUN and data['workflow_run']['head_sha'] == CONTROLLER, 'artifact provenance mismatch')
    require(data['digest'] == 'sha256:'+ZIP_SHA, 'artifact digest mismatch')
def verify_archive(root):
    archive = root/'runtime.zip'
    require(hashlib.sha256(archive.read_bytes()).hexdigest() == ZIP_SHA, 'ZIP digest mismatch')
    with zipfile.ZipFile(archive) as z:
        require(z.namelist() == ['runtime.tgz'], 'unexpected ZIP inventory')
        payload = z.read('runtime.tgz')
    require(len(payload)==142693161 and hashlib.sha256(payload).hexdigest()==TAR_SHA, 'runtime payload mismatch')
    destination = pathlib.Path('.artifacts/macos-native-runtime')
    destination.mkdir(parents=True, exist_ok=True)
    (destination/'runtime.tgz').write_bytes(payload)
if __name__ == '__main__':
    mode, directory = sys.argv[1:]
    root = pathlib.Path(directory)
    verify_metadata(json.loads((root/'artifact.json').read_text()))
    if mode == 'archive': verify_archive(root)
    else: require(mode == 'metadata', 'invalid mode')
    print('Verified pinned artifact '+mode+'; source '+SOURCE)
