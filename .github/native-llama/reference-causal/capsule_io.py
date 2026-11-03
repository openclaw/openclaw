"""Data-only derived capsule admission; never identify it as the original artifact."""
import json,hashlib,zipfile,stat,struct,zlib,io
from pathlib import Path
sha=lambda data:hashlib.sha256(data).hexdigest()
def load_capsule(archive,spec):
 raw=Path(archive).read_bytes();assert len(raw)==spec['archiveBytes'] and sha(raw)==spec['archiveSha256']
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  items=z.infolist();assert len(items)==1;item=items[0];assert item.filename=='capsule.json' and stat.S_IFMT(item.external_attr>>16)==stat.S_IFREG and item.file_size==spec['jsonBytes']<=spec['maxExpandedBytes'];data=z.read(item)
 assert sha(data)==spec['jsonSha256'];c=json.loads(data);assert c['kind']==spec['kind']=='DERIVED_LOSSLESS_ROI_ANALYSIS_INPUT_NOT_ORIGINAL_ARTIFACT' and c['schema']==1
 assert c['sourceArtifact']['sha256']==spec['originalArtifactSha256'];assert c['originalEightMemberHashes']==spec['originalEightMemberHashes'];assert sha(c['originalOutputSealText'].encode())==spec['originalOutputSealSha256']==c['originalOutputSealSha256'];seal={line.split('  ',1)[1]:line.split('  ',1)[0] for line in c['originalOutputSealText'].splitlines()}
 assert all(seal[n]==h for n,h in spec['originalEightMemberHashes'].items());assert c['sourceScenesSha256']==spec['sourceScenesSha256'];assert sha(c['nativeMaskSourceText'].encode())==c['nativeMaskSourceSha256']==spec['originalEightMemberHashes']['before/brand-proof.json']==spec['originalEightMemberHashes']['after/brand-proof.json']
 assert set(c['rois'])=={'llama-app','ollama'}
 for brand,r in c['rois'].items():
  expected=spec['rois'][brand];assert (r['width'],r['height'])==(34,34);rows=r['rgbaRows'];assert len(rows)==34 and all(len(row)==34*4 for row in rows);assert all(type(v) is int and 0<=v<=255 for row in rows for v in row);pixels=bytes(v for row in rows for v in row);assert len(pixels)==r['rgbaBytes']==expected['rgbaBytes']==4624 and sha(pixels)==r['rgbaSha256']==expected['rgbaSha256'];assert r['bindings']==expected['bindings']
  for binding in r['bindings']:assert binding['sourcePngSha256']==spec['originalEightMemberHashes'][binding['stage']+'/onboarding.png'] and binding['rgbaSha256']==r['rgbaSha256'] and binding['sourceRect'][2:]==[34,34] and binding['wellOffset']==[1,1]
 chunks=[];types=[]
 for record in c['originalColorChunks']:
  chunk=bytes.fromhex(record['chunkHex']);length=struct.unpack('>I',chunk[:4])[0];kind=chunk[4:8];payload=chunk[8:-4];assert kind.decode()==record['type'] and kind in [b'iCCP',b'sRGB',b'gAMA',b'cHRM',b'sBIT'] and len(chunk)==length+12 and sha(chunk)==record['sha256'];assert zlib.crc32(kind+payload)&0xffffffff==struct.unpack('>I',chunk[-4:])[0];assert kind not in types;types.append(kind);chunks.append(chunk)
  if kind==b'iCCP':
   end=payload.index(0);assert payload[end+1]==0;icc=zlib.decompress(payload[end+2:]);assert icc==bytes.fromhex(c['originalICCProfileHex']) and sha(icc)==spec['originalICCProfileSha256']
 assert b'iCCP' in types and {r['type']:r['sha256'] for r in c['originalColorChunks']}==spec['originalColorChunkHashes']
 assert set(c['sources'])=={'before','after'}
 for stage,s in c['sources'].items():
  expected=spec['sourceFullFrameStatistics'][stage];assert all(s[k]==v for k,v in expected.items());assert s['dimensions']==[630,1000] and s['sourceFullFramePixelCount']==630000 and s['sourceFullFrameLightFraction']==s['sourceFullFrameLightPixels']/630000
 return c

def png_chunk(kind,payload):return struct.pack('>I',len(payload))+kind+payload+struct.pack('>I',zlib.crc32(kind+payload)&0xffffffff)
def roi_png(capsule,brand):
 r=capsule['rois'][brand];scan=b''.join(bytes([0])+bytes(row) for row in r['rgbaRows'])
 # Only dimensions/IDAT filtering change; all original encoded RGBA samples and color chunks are copied.
 return b'\x89PNG\r\n\x1a\n'+png_chunk(b'IHDR',struct.pack('>IIBBBBB',34,34,8,6,0,0,0))+b''.join(bytes.fromhex(r['chunkHex']) for r in capsule['originalColorChunks'])+png_chunk(b'IDAT',zlib.compress(scan,9))+png_chunk(b'IEND',b'')
