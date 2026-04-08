# Image generation roundtrip

```yaml qa-scenario
id: image-generation-roundtrip
title: Image generation roundtrip
surface: image-generation
objective: Verify a generated image is saved as media, reattached on the next turn, and described correctly through the vision path.
successCriteria:
  - image_generate produces a saved MEDIA artifact.
  - The generated artifact is reattached on a follow-up turn.
  - The follow-up vision answer describes the generated scene rather than a generic attachment placeholder.
docsRefs:
  - docs/tools/image-generation.md
  - docs/help/testing.md
codeRefs:
  - src/agents/tools/image-generate-tool.ts
  - src/gateway/chat-attachments.ts
  - extensions/qa-lab/src/mock-openai-server.ts
execution:
  kind: custom
  handler: image-generation-roundtrip
  summary: Verify a generated image is saved as media, reattached on the next turn, and described correctly through the vision path.
  config:
    generatePrompt: "Image generation check: generate a QA lighthouse image and summarize it in one short sentence."
    generatePromptSnippet: "Image generation check"
    inspectPrompt: "Roundtrip image inspection check: describe the generated lighthouse attachment in one short sentence."
    expectedNeedle: "lighthouse"
```
