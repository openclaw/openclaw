"""Read original PNG encoded channels without fitting or color correction."""
import hashlib,struct,zlib
from pathlib import Path

def decode_png(path):
 data=Path(path).read_bytes();assert data[:8]==b'\x89PNG\r\n\x1a\n'
 offset=8;compressed=bytearray();header=None;profile=None;chunks=[]
 while offset<len(data):
  length=struct.unpack('>I',data[offset:offset+4])[0];kind=data[offset+4:offset+8];payload=data[offset+8:offset+8+length];crc=struct.unpack('>I',data[offset+8+length:offset+12+length])[0]
  assert zlib.crc32(kind+payload)&0xffffffff==crc;offset+=12+length;chunks.append(kind.decode())
  if kind==b'IHDR':header=struct.unpack('>IIBBBBB',payload)
  elif kind==b'IDAT':compressed.extend(payload)
  elif kind==b'iCCP':
   end=payload.index(0);icc=zlib.decompress(payload[end+2:]);profile={'name':payload[:end].decode(),'sha256':hashlib.sha256(icc).hexdigest(),'bytes':len(icc),'colorSpace':icc[16:20].decode(),'pcs':icc[20:24].decode(),'tags':{}}
   count=struct.unpack('>I',icc[128:132])[0]
   for i in range(count):
    tag=icc[132+12*i:136+12*i].decode();start,size=struct.unpack('>II',icc[136+12*i:144+12*i]);value=icc[start:start+size];row={'kind':value[:4].decode(errors='replace'),'bytes':size,'sha256':hashlib.sha256(value).hexdigest()}
    if value[:4]==b'desc':row['text']=value[12:12+struct.unpack('>I',value[8:12])[0]].rstrip(b'\0').decode(errors='replace')
    if value[:4]==b'curv':
     n=struct.unpack('>I',value[8:12])[0];row['entries']=n
     if n==1:row['gamma']=struct.unpack('>H',value[12:14])[0]/256
     elif n>1:
      curve=struct.unpack('>'+str(n)+'H',value[12:12+2*n]);row['fixedSamples']={str(k):curve[round(k*(n-1))]/65535 for k in [0,0.25,0.5,0.75,1]}
    profile['tags'][tag]=row
   transforms=['wtpt','bkpt','rXYZ','gXYZ','bXYZ','rTRC','gTRC','bTRC','chad','aarg','aabg','aagg']
   profile['transformSha256']=hashlib.sha256(''.join(k+profile['tags'][k]['sha256'] for k in transforms if k in profile['tags']).encode()).hexdigest()
  if kind==b'IEND':break
 assert header and offset==len(data);w,h,depth,color,compression,filtering,interlace=header
 assert depth==8 and color in (2,6) and (compression,filtering,interlace)==(0,0,0)
 channels=4 if color==6 else 3;raw=zlib.decompress(compressed);stride=w*channels;assert len(raw)==h*(stride+1);previous=bytearray(stride);rows=[]
 for y in range(h):
  start=y*(stride+1);kind=raw[start];row=bytearray(raw[start+1:start+1+stride]);assert kind in range(5)
  for x in range(stride):
   a=row[x-channels] if x>=channels else 0;b=previous[x];c=previous[x-channels] if x>=channels else 0;prediction=0
   if kind==1:prediction=a
   elif kind==2:prediction=b
   elif kind==3:prediction=(a+b)//2
   elif kind==4:
    p=a+b-c;dist=(abs(p-a),abs(p-b),abs(p-c));prediction=(a,b,c)[dist.index(min(dist))]
   row[x]=(row[x]+prediction)&255
  rows.append([tuple(row[x:x+3])+(row[x+3] if channels==4 else 255,) for x in range(0,stride,channels)]);previous=row
 return {'width':w,'height':h,'rows':rows,'profile':profile,'chunks':chunks,'sha256':hashlib.sha256(data).hexdigest()}

def crop(image,x,y,width=32,height=32):
 assert x>=0 and y>=0 and x+width<=image['width'] and y+height<=image['height']
 return [row[x:x+width] for row in image['rows'][y:y+height]]

def mask(rgba,threshold=180):
 return [''.join('1' if max(p[:3])<threshold and p[3]>128 else '0' for p in row) for row in rgba]

def dice(a,b):
 assert len(a)==len(b) and all(len(x)==len(y) for x,y in zip(a,b))
 na=sum(x.count('1') for x in a);nb=sum(x.count('1') for x in b);intersection=sum(p==q=='1' for x,y in zip(a,b) for p,q in zip(x,y));return 2*intersection/(na+nb) if na+nb else 0.0

def best_match(page,reference,origin,tolerance=1):
 best={'dice':0.0,'origin':None}
 for y in range(round(origin[1])-tolerance,round(origin[1])+tolerance+1):
  for x in range(round(origin[0])-tolerance,round(origin[0])+tolerance+1):
   if x<0 or y<0 or y+len(reference)>len(page) or x+len(reference[0])>len(page[0]):continue
   score=dice([r[x:x+len(reference[0])] for r in page[y:y+len(reference)]],reference)
   if score>best['dice']:best={'dice':score,'origin':[x,y]}
 return best
