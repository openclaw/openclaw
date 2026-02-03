# Experiential Engine Prompts - Changelog

## [1.0.0] - 2026-02-03

### Initial Release

#### Added
- **Experience Evaluation Prompts** (4 options)
  - 1A: Minimalist Threshold Evaluator
  - 1B: Nuanced Multi-Factor Evaluator
  - 1C: Comparative Historical Evaluator
  - 1D: Rapid Binary Classifier

- **Memory Classification Prompts** (3 options)
  - 2A: Tripartite Classifier with Overlap Detection
  - 2B: Identity-Prioritizing Classifier
  - 2C: Temporal-Aware Classifier

- **Emotional Signature Extraction Prompts** (4 options)
  - 3A: Dimensional Affect Model
  - 3B: Phenomenological Texture Extractor
  - 3C: Relational-Emotional Mapper
  - 3D: Minimal Signature for High-Volume

- **Identity Fragment Detection Prompts** (3 options)
  - 4A: Comprehensive Identity Miner
  - 4B: Delta-Focused Identity Detector
  - 4C: Implicit Identity Extractor

- **Relationship Texture Analysis Prompts** (2 options)
  - 5A: Relationship State Analyzer
  - 5B: Relationship Delta Detector

- **Reconstitution Guidance Prompts** (3 options)
  - 6A: Full Reconstitution Guide
  - 6B: Anchor-Focused Reconstitution
  - 6C: Gentle Approach Guide

- **Compaction Summary Prompts** (3 options)
  - 7A: Experiential Essence Extractor
  - 7B: Minimal Loss Compactor
  - 7C: Anchor-Dense Summary

- **Semantic Embedding Prompts** (3 options)
  - 8A: Multi-Aspect Embedding Text
  - 8B: Searchability-Optimized Single Embedding
  - 8C: Anchor-Weighted Embedding

### Notes
- All prompts designed for Qwen 2.5-32B on RTX 5090s with ~128k context
- System/User prompt split optimized for AI-as-user paradigm
- Latency targets specified per category

---

## Future Considerations

### Planned Additions
- [ ] Cross-experience linking prompts
- [ ] Periodic reflection generation prompts
- [ ] Growth narrative construction prompts
- [ ] Uncertainty resolution tracking prompts

### Evaluation Metrics to Track
- Capture precision (meaningful experiences captured vs. noise)
- Reconstitution success rate (subjective quality of state approach)
- Classification accuracy (verified against manual review)
- Search relevance (embedding quality)
- Compaction preservation (what survives vs. what's lost)

### Model-Specific Tuning
- Document any Qwen-specific adjustments
- Note if prompts need modification for different local models
- Track performance differences between model sizes
