"""Controller-only retained capture recovery. Inputs remain immutable; all_results runs whole."""
from pathlib import Path
import json, subprocess, sys

HERE = Path(__file__).parent
sys.path.insert(0,str(HERE/'payload'))
from reference_consumer import digest, sealed_root, external_output

def run(original, reference, output):
    output = external_output(output,original,reference)
    output.mkdir(parents=True)
    pins = json.loads((HERE/'payload/SOURCE-PINS.json').read_text())
    original_members = sealed_root(original,pins['retainedReferenceConsumer']['originalArtifactSealSha256'],70)
    assert len(list(original.rglob('*.png'))) == 2
    before = {name:digest(original/name) for name in original_members}
    old = subprocess.run([sys.executable,'-B',str(HERE/'baseline/verify-results.py'),'all',str(original)],capture_output=True,text=True)
    (output/'original-red.log').write_text(old.stdout+old.stderr)
    assert old.returncode != 0 and 'ollama' in old.stderr and 'native mark missing/misrendered' in old.stderr and '0.8478260869565217' in old.stderr, 'Original failure was not reproduced'
    new = subprocess.run([sys.executable,'-B',str(HERE/'payload/verify-results.py'),'all',str(original),str(reference),str(output/'requalified.json')],capture_output=True,text=True)
    (output/'repaired.log').write_text(new.stdout+new.stderr)
    assert new.returncode == 0, new.stderr
    result = json.loads((output/'requalified.json').read_text())
    assert len(result['frames']) == 2 and len(result['tests']) == 2
    assert all(t['completedSelectedFunctions'] == 1 and t['exit'] == 0 and t['issueLines'] == [] for t in result['tests'])
    assert before == {name:digest(original/name) for name in original_members}
    sealed_root(original,pins['retainedReferenceConsumer']['originalArtifactSealSha256'],70)
    receipt = {'status':'REQUALIFIED_RETAINED_CAPTURES','originalRunRemainsFailed':41572287535,'diagnosticRun':41583993773,'oldExit':old.returncode,'repairedExit':new.returncode,'allOriginalNonReferenceChecksCompleted':True,'all70OriginalSealsUnchanged':True,'newNativeOperations':0,'newPNGs':0,'inferenceAttempted':False,'wholeCacheEquivalenceClaimed':False,'referenceCase':'file-source-paint','referencePhase':'first','referenceChoiceWasPredeclared':True,'frames':[{'stage':f['stage'],'sha256':f['sha256'],'lightFraction':f['lightFraction'],'matches':f['brandMatches']} for f in result['frames']]}
    (output/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'status':receipt['status'],'oldExit':old.returncode,'repairedExit':new.returncode,'allNonReferenceChecks':True}))

if __name__ == '__main__':
    assert len(sys.argv) == 4, 'requalify.py ORIGINAL_ARTIFACT_ROOT PINNED_REFERENCE_ARTIFACT_ROOT FRESH_OUTPUT_DIR'
    run(*(Path(a).resolve() for a in sys.argv[1:]))
