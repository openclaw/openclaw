# İlk Adapter Spike İskeleti

Önerilen başlangıç:

```text
sketchup-vray-interior-agent/
  contracts/
    scene-context-contract-v1.json
    sketchup-bridge-request-envelope-v1.json
    sketchup-bridge-result-envelope-v1.json
  scripts/
    verify_contract_examples.py
    run-sketchup-bridge-request.py
  windows-helper/
    runner.ps1
    handlers/
      ping.ps1
      capabilities.ps1
      extract-presentation-context.ps1
      shared.ps1
    extractors/
      get-active-scene-live.rb
      get-material-summary-live.rb
      get-camera-shot-summary-live.rb
```

Kısa yaklaşım:

- `handlers/` allowlist ve response biçimini korur
- `extractors/` sadece host'tan veri toplar
- İlk spike'ta `extract-presentation-context.ps1`, seeded JSON ile başlayıp sonra Ruby extractor'a bağlanır
- V-Ray extraction ilk turda ayrı dosya olabilir: `get-render-readiness-live.rb`
