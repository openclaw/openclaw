"""Admit a derived ROI capsule, not the original full native artifact."""
from pathlib import Path
import sys,json,hashlib,shutil
sys.path.insert(0,str(Path(__file__).parent))
from capsule_io import load_capsule,roi_png
packet=Path(__file__).parent;plan=json.loads((packet/'diagnostic-plan.json').read_text());spec=json.loads((packet/'capsule-spec.json').read_text());archive=Path(sys.argv[1]);destination=Path(sys.argv[2]);assert not destination.exists();capsule=load_capsule(archive,spec)
assert hashlib.sha256((packet/'scenes.json').read_bytes()).hexdigest()==spec['sourceScenesSha256'];destination.mkdir(parents=True);(destination/'retained').mkdir()
for brand in ['llama-app','ollama']:(destination/'retained'/('roi-'+brand+'.png')).write_bytes(roi_png(capsule,brand))
for stage in ['before','after']:
 (destination/'retained'/stage).mkdir();(destination/'retained'/stage/'brand-proof.json').write_text(capsule['nativeMaskSourceText'])
for n in ['diagnostic-plan.json','scenes.json']:shutil.copyfile(packet/n,destination/n)
(destination/'assets').mkdir()
for asset in plan['assets'].values():
 data=(packet/'assets'/asset['filename']).read_bytes();assert hashlib.sha256(data).hexdigest()==asset['sha256'];(destination/'assets'/asset['filename']).write_bytes(data)
provenance={k:capsule[k] for k in ['kind','sourceArtifact','originalRun','originalHead','originalEightMemberHashes','originalOutputSealSha256','sourceScenesSha256','sources','equivalenceScope']};provenance['derivedCapsuleSha256']=spec['archiveSha256'];provenance['roiBindings']={k:{x:r[x] for x in ['width','height','rgbaSha256','bindings']} for k,r in capsule['rois'].items()};(destination/'capsule-provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
rows={str(p.relative_to(destination)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(destination.rglob('*')) if p.is_file()};(destination/'ADMITTED-SHA256SUMS').write_text(''.join(h+'  '+n+'\n' for n,h in rows.items()))
print(json.dumps({'status':'DERIVED_ROI_ANALYSIS_INPUT_ADMITTED','derivedCapsuleSha256':spec['archiveSha256'],'originalArtifactSha256ProvenanceOnly':plan['originalArtifact']['sha256'],'inputs':rows,'wholeOriginalImageOrCacheEquivalenceClaimed':False,'nativeExecution':False},indent=2))
