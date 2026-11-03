"""Retained classifier negatives; no fabricated positive or patched verifier functions."""
from pathlib import Path
import importlib.util,json,sys,time,tempfile,shutil,subprocess
HERE=Path(__file__).parent
sys.path.insert(0,str(HERE/'payload'))
from reference_consumer import ReferenceArtifact, external_output
from png_codec import decode_png,mask
spec=importlib.util.spec_from_file_location('verifier',HERE/'payload/verify-results.py')
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)

def rejected(page,refs,brand,origin):
    c=v.PINS['brandPixelContract']
    scores={name:v.best_glyph_match(page,ref,origin,c['positionTolerancePoints'])['dice'] for name,ref in refs.items()}
    return not(scores[brand]>=c['minimumDice'] and scores[brand]-max(s for n,s in scores.items() if n!=brand)>=c['minimumWinningMargin']),scores

def main(original,reference,output):
    output=external_output(output,original,reference)
    start=time.monotonic();artifact=ReferenceArtifact(reference);negative=[]
    for stage in ('before','after'):
        path=original/stage/'onboarding.png';refs=artifact.masks(path,stage,1);actual=mask(decode_png(path)['rows'])
        ax=json.loads((original/stage/'onboarding.accessibility.json').read_text())
        # Real consumer and whole-image masks: two independently captured marks, not synthetic positives.
        matches=v.branded_pixels(original,stage,ax,1,actual,artifact)
        assert all(m['scores'][m['brandId']]['dice']==1 for m in matches)
        for brand in ('llama-app','ollama'):
            other='ollama' if brand=='llama-app' else 'llama-app'
            for name,rows in {'wrong-brand':refs[other],'blank':['0'*32]*32,'generic-arrow':refs['fallback']}.items():
                page=['0'*34]+['0'+r+'0' for r in rows]+['0'*34]
                fail,scores=rejected(page,refs,brand,(1,1));assert fail,(stage,brand,name,scores)
                negative.append({'stage':stage,'brand':brand,'control':name,'rejected':True,'scores':scores})
    # Entry refuses absence of explicit artifact; altered evidence cannot be blessed by caller masks.
    try:ReferenceArtifact(original)
    except AssertionError:pass
    else:raise AssertionError('Wrong artifact accepted')
    # A changed reference file cannot be admitted even with the original pinned seal.
    with tempfile.TemporaryDirectory(prefix='reference-mutation-',dir=output.parent) as folder:
        changed=Path(folder)/'artifact';shutil.copytree(reference,changed)
        png=changed/'native/ollama/file-source-paint/first.png'
        data=png.read_bytes();png.write_bytes(data[:-1]+bytes([data[-1]^1]))
        try:ReferenceArtifact(changed)
        except AssertionError:pass
        else:raise AssertionError('Altered reference accepted')
    placements=[]
    for root in (original,reference):
        for entry in ('controller','verifier'):
            target=root/('forbidden-'+entry)
            assert not target.exists()
            args=([str(HERE/'requalify.py'),str(original),str(reference),str(target)] if entry=='controller' else [str(HERE/'payload/verify-results.py'),'all',str(original),str(reference),str(target)])
            proc=subprocess.run([sys.executable,'-B',*args],capture_output=True,text=True)
            assert proc.returncode!=0 and 'Output must be outside both immutable artifact roots' in proc.stderr and not target.exists()
            placements.append({'entry':entry,'input':('original' if root==original else 'reference'),'rejectedBeforeWrite':True})
    result={'outputPlacementControls':placements,'alteredReferenceRejected':True,'status':'PASS','positiveSource':'exact original full PNG through real branded_pixels consumer','controls':negative,'wrongArtifactRejected':True,'wallSeconds':time.monotonic()-start,'scope':'Classifier + immutable artifact admission; controller separately runs complete all_results'}
    output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':'PASS','negativeControls':len(negative),'wallSeconds':result['wallSeconds']}))
if __name__=='__main__':main(*(Path(a).resolve() for a in sys.argv[1:]))
