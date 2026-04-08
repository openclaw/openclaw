# Image understanding from attachment

```yaml qa-scenario
id: image-understanding-attachment
title: Image understanding from attachment
surface: image-understanding
objective: Verify an attached image reaches the agent model and the agent can describe what it sees.
successCriteria:
  - Agent receives at least one image attachment.
  - Final answer describes the visible image content in one short sentence.
  - The description mentions the expected red and blue regions.
docsRefs:
  - docs/help/testing.md
  - docs/tools/index.md
codeRefs:
  - src/gateway/server-methods/agent.ts
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/mock-openai-server.ts
execution:
  kind: custom
  handler: image-understanding-attachment
  summary: Verify an attached image reaches the agent model and the agent can describe what it sees.
  config:
    prompt: "Image understanding check: describe the top and bottom colors in the attached image in one short sentence."
    requiredColorGroups:
      - [red, scarlet, crimson]
      - [blue, azure, teal, cyan, aqua]
```
