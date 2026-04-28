# SolidWorks Orchestrator Delegation Playbook

## Amaç

Bu not, orchestrator'ın mevcut Windows executor hattına delegasyon yaparken izleyeceği en küçük ama gerçekçi akışı sabitler.

Odak:

- yeni framework kurmamak
- mevcut queue/request/result hattını kullanmak
- ilk canlı seam olan `get-active-document` üzerinden host gerçekliğini görmek
- daha derin extraction hazır değilken seeded fallback ile ilerlemek

## Şu an gerçekten hazır olan yüzey

- queue tabanlı request/response hattı
- Windows helper runner allowlist'i
- typed result envelope
- `get-active-document` için canlı COM seam
- diğer SolidWorks komutları için seeded/stub contract yüzeyi

## Önerilen delegasyon sırası

### 1. Ön uç / orchestrator önce capability yoklasın

İlk çağrı:

- `capabilities`

Amaç:

- helper ayakta mı
- hangi komutlar destekleniyor
- feature listesinde halen `seeded-probe` mi var

### 2. Sonra canlı host var mı diye küçük yoklama yapsın

İkinci çağrı:

- `get-active-document`
- `payload.extractionMode=prefer-live`

Amaç:

- Windows executor gerçekten SolidWorks host'una attach olabiliyor mu
- aktif doküman var mı
- canlı yol başarısızsa fallback nedeni `diagnostics.warnings` içinde görülebiliyor mu

### 3. Daha derin review için kontrollü fallback kullansın

Üçüncü çağrı:

- `extract-poc-context`

Bugünkü beklenti:

- bu çağrı halen seeded/stub veri döndürür
- orchestrator bunu "canlı model özeti + seeded derin bağlam" diye açıkça işaretlemelidir

Bu sayede kullanıcıya yanlış canlılık hissi verilmez.

## Karar kuralı

- `get-active-document` canlı dönerse: host erişimi doğrulandı kabul et
- `get-active-document` fallback ile seeded dönerse: transport tamam, live seam başarısız kabul et
- `get-active-document` failed dönerse: typed error kodunu kullanıcıya ve log'a aynen taşı

## Typed failure kodları

- `host-platform-unsupported`
- `solidworks-host-not-running`
- `solidworks-no-active-document`
- `invalid-extraction-mode`

## Örnek request payload

```json
{
  "extractionMode": "prefer-live"
}
```

## Örnek delegasyon komutları

Canlı host yoklaması:

```bash
python3 solidworks-copilot/scripts/run-solidworks-bridge-request.py \
  get-active-document \
  --payload-file solidworks-copilot/examples/get-active-document/prefer-live.payload.json
```

Seeded derin bağlam:

```bash
python3 solidworks-copilot/scripts/run-solidworks-bridge-request.py \
  extract-poc-context
```

## Bu fazdan sonra en mantıklı teknik adım

Bir sonraki küçük teknik faz:

- `extract-poc-context` içine `get-active-document` canlı sonucunu katmak
- canlı olmayan metadata/selection/assembly parçalarını seeded olarak bırakmak

Böylece tüm extraction katmanını bir anda canlıya çevirmeden, orchestrator tek çağrıda "kısmen canlı" bağlam alabilir.
