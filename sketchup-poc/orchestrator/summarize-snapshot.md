# Summarize Snapshot Prompt Notes

Bir snapshot alındığında ilk özet şu başlıkları üretmeli:

- Source
- Model Overview
- Most Common Tags
- Most Reused Components
- Selection State
- Warnings / Notes

## Basit uyarı kuralları

- entityCount çok büyükse uyar
- isimsiz entity oranı yüksekse uyar
- tagsiz entity oranı yüksekse uyar
- selection boşsa bilgi notu düş
