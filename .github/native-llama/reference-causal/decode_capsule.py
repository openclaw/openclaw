from pathlib import Path
import os,sys,json,base64,hashlib
sys.path.insert(0,str(Path(__file__).parent))
from capsule_io import load_capsule
packet=Path(__file__).parent;spec=json.loads((packet/'capsule-spec.json').read_text());text=os.environ.get('LLAMA_RETAINED_CAPSULE_B64','');allInputs=os.environ.get('LLAMA_DISPATCH_INPUTS_JSON','')
assert text and text.isascii() and len(text)==spec['base64Bytes']<=spec['maxBase64Bytes']<65535
assert allInputs and len(allInputs.encode())<=65535;inputs=json.loads(allInputs);assert inputs['retained_capsule_b64']==text;assert inputs['platform']=='mac-reference-diag'
assert hashlib.sha256(text.encode()).hexdigest()==spec['base64Sha256'];data=base64.b64decode(text,validate=True);assert len(data)==spec['archiveBytes'] and hashlib.sha256(data).hexdigest()==spec['archiveSha256'];output=Path(sys.argv[1]);assert not output.exists();output.write_bytes(data);load_capsule(output,spec)
print(json.dumps({'status':'ONE_DERIVED_DATA_FIELD_ADMITTED','bytes':len(data),'sha256':spec['archiveSha256'],'totalInputsJsonBytes':len(allInputs.encode()),'splitFields':False,'originalArtifactNotAdmittedOrRelabeled':True}))
