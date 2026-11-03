"""Analyze all predeclared references; never select a fitted passing mask."""
from pathlib import Path
import sys,json,hashlib,struct,math
from png_codec import decode_png,crop,mask,dice,best_match

def float_rgba(path,size):
 data=Path(path).read_bytes();assert len(data)==size*size*4*8
 values=struct.unpack('<'+str(size*size*4)+'d',data);assert all(math.isfinite(v) and -0.001<=v<=1.001 for v in values)
 return [[tuple(values[(y*size+x)*4:(y*size+x+1)*4]) for x in range(size)] for y in range(size)]
def float_mask(rgba):
 return [''.join('1' if max(p[:3])*255<180 and p[3]>0.5 else '0' for p in row) for row in rgba]
def classify(page,refs,brand,origin=(1,1)):
 scores={key:best_match(page,value,origin,1)['dice'] for key,value in refs.items()}
 margin=scores[brand]-max(value for key,value in scores.items() if key!=brand)
 return {'scores':scores,'margin':margin,'pass':scores[brand]>=0.85 and margin>=0.10}
def main(input,output):
 plan=json.loads((input/'diagnostic-plan.json').read_text());assert plan['guards']=={'minimumDice':.85,'minimumWinningMargin':.10,'placementTolerancePoints':1,'darkThreshold':180,'minimumLightFraction':.50}
 index=json.loads((output/'reference-index.json').read_text());assert index['status'].startswith('REFERENCE_DIAGNOSTIC_ONLY');assert index['planSha256']==hashlib.sha256((input/'diagnostic-plan.json').read_bytes()).hexdigest()
 records={(r['brand'],r['case']):r for r in index['records']};assert len(records)==2*len(plan['caseIds']);assert set(records)=={(b,c) for b in ['llama-app','ollama'] for c in plan['caseIds']}
 scenes=json.loads((input/'scenes.json').read_text())['scenes'];actual={};old={};baseline=[]
 provenance=json.loads((input/'capsule-provenance.json').read_text());assert provenance['kind']=='DERIVED_LOSSLESS_ROI_ANALYSIS_INPUT_NOT_ORIGINAL_ARTIFACT'
 observations={(r['stage'],r['brand']):r for r in index['actualColorObservations']};assert set(observations)=={(s,b) for s in ['before','after'] for b in ['llama-app','ollama']}
 for scene in scenes:
  stage=scene['stage'];source=provenance['sources'][stage]
  assert source['pngSha256']==plan['retainedMembers'][stage+'/onboarding.png']
  assert source['sourceFullFramePixelCount']==630000 and source['sourceFullFrameLightFraction']==source['sourceFullFrameLightPixels']/630000 and source['sourceFullFrameLightFraction']>=.50
  old[stage]=json.loads((input/'retained'/stage/'brand-proof.json').read_text())
  for choice in scene['choices']:
   brand=choice['brand'];page=decode_png(input/'retained'/('roi-'+brand+'.png'));assert (page['width'],page['height'])==(34,34)
   rgba=page['rows'];assert hashlib.sha256(bytes(v for row in rgba for px in row for v in px)).hexdigest()==provenance['roiBindings'][brand]['rgbaSha256']
   actual[(stage,brand)]={'encoded':mask(rgba),'profile':page['profile']}
   observation=observations[(stage,brand)];assert observation['sourceOriginalPngSha256']==plan['retainedMembers'][stage+'/onboarding.png'];assert observation['derivedRoiPngSha256']==page['sha256'];assert observation['inputKind']=='DERIVED_ROI_NOT_ORIGINAL_FULL_PNG' and observation['wholeImageRepresentationOrCacheEquivalenceClaimed'] is False;assert (observation['rgbaWidth'],observation['rgbaHeight'],observation['margin'])==(34,34,1)
   for space in ['deviceRGB','sRGB']:
    file=output/'retained-colors'/stage/brand/(space+'.f64le');assert hashlib.sha256(file.read_bytes()).hexdigest()==observation[space+'Sha256'];actual[(stage,brand)][space]=float_mask(float_rgba(file,34))
 assert all(old['before']['brands'][b]['mask']['rows']==old['after']['brands'][b]['mask']['rows'] for b in ['llama-app','ollama'])
 cache={};rows=[];candidate=[];negatives=[]
 for record in index['records']:
  brand,case=record['brand'],record['case'];assert record['assetSha256']==plan['assets'][brand]['sha256'];result=record['result'];assert result['backingScale']==1
  assert result['nominalImageSize']['width']>0 and result['nominalImageSize']['height']>0
  origin=tuple(map(int,record['wellOriginOnReferenceCanvas']));folder=output/brand/case
  for phase in ['first','warm-repeat']:
   entry=next(p for p in result['passes'] if p['pass']==phase);png=decode_png(folder/(phase+'.png'));assert png['sha256']==entry['pngSha256'];rgba=crop(png,*origin);encoded=mask(rgba);device=float_mask(float_rgba(folder/(phase+'-deviceRGB.f64le'),32));srgb=float_mask(float_rgba(folder/(phase+'-sRGB.f64le'),32));assert device==entry['nativeDeviceMask']
   cache[(brand,case,phase)]={'encoded':encoded,'deviceRGB':device,'sRGB':srgb,'profile':png['profile'],'rgba':rgba}
   (folder/(phase+'-encodedRGBA8.rgba')).write_bytes(bytes(c for row in rgba for pixel in row for c in pixel))
  first=cache[(brand,case,'first')];warm=cache[(brand,case,'warm-repeat')]
  if case=='old-data-white-small':
   same=first['deviceRGB']==old['before']['brands'][brand]['mask']['rows'];baseline.append({'brand':brand,'retainedNativeMaskReproduced':same})
  rows.append({'brand':brand,'case':case,'role':record['role'],'firstWarmRGBAIdentical':first['rgba']==warm['rgba'],'firstWarmDeviceMaskIdentical':first['deviceRGB']==warm['deviceRGB'],'encodedVersusDeviceMaskDifferences':sum(a!=b for r,t in zip(first['encoded'],first['deviceRGB']) for a,b in zip(r,t)),'encodedVersusSRGBMaskDifferences':sum(a!=b for r,t in zip(first['encoded'],first['sRGB']) for a,b in zip(r,t)),'encodedProfile':first['profile'],'nativeGeometryAndRepresentations':result})
 # The same fallback producer/domain is used for every case; no "best case" selection.
 fallbackPNG=decode_png(output/'fallback/first.png');fallback={'encoded':mask(crop(fallbackPNG,0,0)),'deviceRGB':float_mask(float_rgba(output/'fallback/first-deviceRGB.f64le',32)),'sRGB':float_mask(float_rgba(output/'fallback/first-sRGB.f64le',32))}
 comparisons=[]
 for case in plan['caseIds']:
  refs={space:{brand:cache[(brand,case,'first')][space] for brand in ['llama-app','ollama']}|{'fallback':fallback[space]} for space in ['encoded','deviceRGB','sRGB']}
  for scene in scenes:
   stage=scene['stage']
   for choice in scene['choices']:
    brand=choice['brand'];observed=actual[(stage,brand)];domains={space:classify(observed[space],refs[space],brand) for space in refs}
    profile=observed['profile'];referenceProfile=cache[(brand,case,'first')]['profile'];comparable=bool(profile and referenceProfile and profile['transformSha256']==referenceProfile['transformSha256']);domains['encoded']['profileComparable']=comparable;domains['encoded']['pass']=domains['encoded']['pass'] and comparable
    comparisons.append({'stage':stage,'brand':brand,'case':case,'domains':domains,'acceptanceEligible':case==plan['predeclaredMinimalCandidate']})
    if case==plan['predeclaredMinimalCandidate']:
     candidate.append({'stage':stage,'brand':brand,'strictEncodedCandidatePass':domains['encoded']['pass']})
     other='ollama' if brand=='llama-app' else 'llama-app'
     retainedArrow=['0'*34]+['0'+r+'0' for r in old[stage]['fallback']['rows']]+['0'*34]
     controls={'wrong-brand-retained':actual[(stage,other)]['encoded'],'blank':['0'*34]*34,'generic-arrow-retained':retainedArrow}
     for name,invalid in controls.items():
      verdict=classify(invalid,refs['encoded'],brand);assert not verdict['pass'],('Negative control accepted',stage,brand,name);negatives.append({'stage':stage,'brand':brand,'control':name,'rejected':True,'scores':verdict['scores']})
 result={'actualInputScope':'DERIVED34x34ROI exact encoded RGBA/ICC; not original full image/cache state','wholeImageDecodeOrCacheInferenceAvailable':False,'lightGuardEvidence':'unchanged .50 guard against sealed source full-frame count/fraction bound to original PNG hash, not recomputed from cropped image','status':'DIAGNOSTIC_ONLY_PARENT_REVIEW_REQUIRED_ORIGINAL_RUN_REMAINS_FAILED','baseline':baseline,'baselineReproduced':all(r['retainedNativeMaskReproduced'] for r in baseline),'predeclaredMinimalCandidate':plan['predeclaredMinimalCandidate'],'candidate':candidate,'candidateAllStrictGuardsPass':all(r['strictEncodedCandidatePass'] for r in candidate),'comparisons':comparisons,'referenceCases':rows,'negativeControls':negatives,'noAutomaticCaseOrPhaseSelection':True,'notAQualificationOrThresholdWaiver':True}
 (output/'diagnostic-analysis.json').write_text(json.dumps(result,indent=2)+'\n')
 assert result['baselineReproduced'],'Old exact baseline not reproduced: no causal attribution authorized'
 print(json.dumps({'status':result['status'],'baselineReproduced':True,'candidateAllStrictGuardsPass':result['candidateAllStrictGuardsPass'],'negativeControls':len(negatives)}))
if __name__=='__main__':main(Path(sys.argv[1]),Path(sys.argv[2]))
