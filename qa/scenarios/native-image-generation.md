# Native image generation

```yaml qa-scenario
id: native-image-generation
title: Native image generation
surface: image-generation
objective: Verify image_generate appears when configured and returns a real saved media artifact.
successCriteria:
  - image_generate appears in the effective tool inventory.
  - Agent triggers native image_generate.
  - Tool output returns a saved MEDIA path and the file exists.
docsRefs:
  - docs/tools/image-generation.md
  - docs/providers/openai.md
codeRefs:
  - src/agents/tools/image-generate-tool.ts
  - extensions/qa-lab/src/mock-openai-server.ts
execution:
  kind: custom
  handler: native-image-generation
  summary: Verify image_generate appears when configured and returns a real saved media artifact.
  config:
    prompt: "Image generation check: generate a QA lighthouse image and summarize it in one short sentence."
    promptSnippet: "Image generation check"
    generatedNeedle: "QA lighthouse"
```
