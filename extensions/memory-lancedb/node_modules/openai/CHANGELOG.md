# Changelog

## 6.33.0 (2026-03-25)

Full Changelog: [v6.32.0...v6.33.0](https://github.com/openai/openai-node/compare/v6.32.0...v6.33.0)

### Features

* **api:** add keys field to computer action types ([27a850e](https://github.com/openai/openai-node/commit/27a850e8a698cde5b7e05da70d8babb1205b2830))
* **client:** add async iterator and stream() to WebSocket classes ([e1c16ee](https://github.com/openai/openai-node/commit/e1c16ee35b8ef9db30e9a99a2b3460368f3044d0))


### Bug Fixes

* **api:** align SDK response types with expanded item schemas ([491cd52](https://github.com/openai/openai-node/commit/491cd5290c36e6b1de7ff9787e80c73899d8b642))
* **types:** make type required in ResponseInputMessageItem ([2012293](https://github.com/openai/openai-node/commit/20122931977c2de8630cb03182766fbf6dc37868))


### Chores

* **ci:** skip lint on metadata-only changes ([74a917f](https://github.com/openai/openai-node/commit/74a917fd92dd2a1bd3089f3b5f79781bdc0d4ec3))
* **internal:** refactor imports ([cfe9c60](https://github.com/openai/openai-node/commit/cfe9c60aa41e9ed53e7d5f9187d31baf4364f8bd))
* **internal:** update gitignore ([71bd114](https://github.com/openai/openai-node/commit/71bd114f97e24c547660694d03c19b22d62ae961))
* **tests:** bump steady to v0.19.4 ([f2e9dea](https://github.com/openai/openai-node/commit/f2e9dea844405f189cc63a1d1493de3eabfcb7e7))
* **tests:** bump steady to v0.19.5 ([37c6cf4](https://github.com/openai/openai-node/commit/37c6cf495b9a05128572f9e955211b67d01410f3))
* **tests:** bump steady to v0.19.6 ([496b3af](https://github.com/openai/openai-node/commit/496b3af4371cf40f5d14f72d0770e152710b09df))
* **tests:** bump steady to v0.19.7 ([8491eb6](https://github.com/openai/openai-node/commit/8491eb6d83cf8680bdc9d69e60b8e5d09e2bc8e8))


### Refactors

* **tests:** switch from prism to steady ([47c0581](https://github.com/openai/openai-node/commit/47c0581a1923c9e700a619dd6bfa3fb93a188899))

## 6.32.0 (2026-03-17)

Full Changelog: [v6.31.0...v6.32.0](https://github.com/openai/openai-node/compare/v6.31.0...v6.32.0)

### Features

* **api:** 5.4 nano and mini model slugs ([068df6d](https://github.com/openai/openai-node/commit/068df6d625d7faa76dfac160065f1ca550539ba8))

## 6.31.0 (2026-03-16)

Full Changelog: [v6.30.1...v6.31.0](https://github.com/openai/openai-node/compare/v6.30.1...v6.31.0)

### Features

* **api:** add in/nin filter types to ComparisonFilter ([b2eda27](https://github.com/openai/openai-node/commit/b2eda274418ceb9bbdb3778cb6a5ee28090df8ad))

## 6.30.1 (2026-03-16)

Full Changelog: [v6.30.0...v6.30.1](https://github.com/openai/openai-node/compare/v6.30.0...v6.30.1)

### Chores

* **internal:** tweak CI branches ([25f5d74](https://github.com/openai/openai-node/commit/25f5d74c1fc16e3303fcb87022f5f0559b052cbf))

## 6.30.0 (2026-03-16)

Full Changelog: [v6.29.0...v6.30.0](https://github.com/openai/openai-node/compare/v6.29.0...v6.30.0)

### Features

* **api:** add /v1/videos endpoint option to batches ([271d879](https://github.com/openai/openai-node/commit/271d87979f16950900f4253915bdda319b7fe935))
* **api:** add defer_loading field to NamespaceTool ([7cc8f0a](https://github.com/openai/openai-node/commit/7cc8f0a736ea7ba0aa3e7860b4c30eaaa5795966))


### Bug Fixes

* **api:** oidc publishing for npm ([fa50066](https://github.com/openai/openai-node/commit/fa500666e38379f2241ac43d60e2eb7eef7d39cb))

## 6.29.0 (2026-03-13)

Full Changelog: [v6.28.0...v6.29.0](https://github.com/openai/openai-node/compare/v6.28.0...v6.29.0)

### Features

* **api:** custom voices ([a11307a](https://github.com/openai/openai-node/commit/a11307afab49299fdf7e7ed3675d3e277d9b5c60))

## 6.28.0 (2026-03-13)

Full Changelog: [v6.27.0...v6.28.0](https://github.com/openai/openai-node/compare/v6.27.0...v6.28.0)

### Features

* **api:** manual updates ([d543959](https://github.com/openai/openai-node/commit/d54395976aa4c1c1864bb45dbaf81ec1d66b8c6b))
* **api:** manual updates ([4f87840](https://github.com/openai/openai-node/commit/4f878406e029ae7527201251632e3fa00b800045))
* **api:** sora api improvements: character api, video extensions/edits, higher resolution exports. ([262dac2](https://github.com/openai/openai-node/commit/262dac25aec6c9caa561f57a0b9e2a086f47a26a))


### Bug Fixes

* **types:** remove detail field from ResponseInputFile and ResponseInputFileContent ([8d6c0cd](https://github.com/openai/openai-node/commit/8d6c0cdbbf08829db08745597e1806661534853f))


### Chores

* **internal:** update dependencies to address dependabot vulnerabilities ([f5810ee](https://github.com/openai/openai-node/commit/f5810ee5f5bf96e81a77f91939f3d56427c46e00))
* match http protocol with ws protocol instead of wss ([6f4e936](https://github.com/openai/openai-node/commit/6f4e936bc2211da885bf492615b2bf413887576b))
* **mcp-server:** improve instructions ([aad9ca1](https://github.com/openai/openai-node/commit/aad9ca15ddbb8dbc27ed6b2aa9b242af9bbf7b8f))
* use proper capitalization for WebSockets ([cb4cf62](https://github.com/openai/openai-node/commit/cb4cf6297c2a0eb7d3f55f8850e6e8ffc4c7ecc6))

## 6.27.0 (2026-03-05)

Full Changelog: [v6.26.0...v6.27.0](https://github.com/openai/openai-node/compare/v6.26.0...v6.27.0)

### Features

* **api:** The GA ComputerTool now uses the CompuerTool class. The 'computer_use_preview' tool is moved to ComputerUsePreview ([0206188](https://github.com/openai/openai-node/commit/0206188f760be830738136e37dcf7be6ea0fe20c))


### Chores

* **internal:** improve import alias names ([9cc2478](https://github.com/openai/openai-node/commit/9cc24789730a309037ef81f5a30af515d700459a))

## 6.26.0 (2026-03-05)

Full Changelog: [v6.25.0...v6.26.0](https://github.com/openai/openai-node/compare/v6.25.0...v6.26.0)

### Features

* **api:** gpt-5.4, tool search tool, and new computer tool ([1d1e5a9](https://github.com/openai/openai-node/commit/1d1e5a9b5aeb11b0e940b4532dcd6a3fcc23898a))


### Bug Fixes

* **api:** internal schema fixes ([6b401ad](https://github.com/openai/openai-node/commit/6b401ad7d3ff2ead9cfa577daf8381f62ea85b93))
* **api:** manual updates ([2b54919](https://github.com/openai/openai-node/commit/2b549195c70581022d9d64c443ab08202c6faeb7))
* **api:** readd phase ([4a0cf29](https://github.com/openai/openai-node/commit/4a0cf2974865519d3b512fb377bc4ba305dce7b7))
* **api:** remove phase from message types, prompt_cache_key param in responses ([088fca6](https://github.com/openai/openai-node/commit/088fca6a4d5d1a577500acb5579ee403292d8911))


### Chores

* **internal:** codegen related update ([6a0aa9e](https://github.com/openai/openai-node/commit/6a0aa9e2ff10e78f8b9afd777174d16537a29c8e))
* **internal:** codegen related update ([b2a4299](https://github.com/openai/openai-node/commit/b2a42991cbe83eee45a342f19a5a99ce1d78b36a))
* **internal:** move stringifyQuery implementation to internal function ([f9f4660](https://github.com/openai/openai-node/commit/f9f46609cf5c1fc51e437c23251c5a7d0519d55d))
* **internal:** reduce warnings ([7e19492](https://github.com/openai/openai-node/commit/7e194929156052b0efbda9ca48c3ed6de8c18d2f))

## 6.25.0 (2026-02-24)

Full Changelog: [v6.24.0...v6.25.0](https://github.com/openai/openai-node/compare/v6.24.0...v6.25.0)

### Features

* **api:** add phase ([e32b853](https://github.com/openai/openai-node/commit/e32b853c3c57f2d0e4c05b09177b94677aed0e5a))


### Bug Fixes

* **api:** fix phase enum ([2ffe1be](https://github.com/openai/openai-node/commit/2ffe1be2600d0154b3355eefa61707470a341a95))
* **api:** phase docs ([7fdfa38](https://github.com/openai/openai-node/commit/7fdfa38c1fa2bd383e1171510918c6db5f0937d8))


### Chores

* **internal:** refactor sse event parsing ([0ea2380](https://github.com/openai/openai-node/commit/0ea238054c0473adc97f4173a0ad5ba8bcfa4e29))

## 6.24.0 (2026-02-24)

Full Changelog: [v6.23.0...v6.24.0](https://github.com/openai/openai-node/compare/v6.23.0...v6.24.0)

### Features

* **api:** add gpt-realtime-1.5 and gpt-audio-1.5 models to realtime ([75875bf](https://github.com/openai/openai-node/commit/75875bfb850c0780878553c566fe8821048ae5e8))

## 6.23.0 (2026-02-23)

Full Changelog: [v6.22.0...v6.23.0](https://github.com/openai/openai-node/compare/v6.22.0...v6.23.0)

### Features

* **api:** websockets for responses api ([c6b96b8](https://github.com/openai/openai-node/commit/c6b96b8b8d5f8132e0a4c5f7399a04185302adcc))


### Bug Fixes

* **docs/contributing:** correct pnpm link command ([8a198a5](https://github.com/openai/openai-node/commit/8a198a5aa60209e26509651cdad110aadf164527))
* **internal:** skip tests that depend on mock server ([3d88cb0](https://github.com/openai/openai-node/commit/3d88cb061a9a4d187931d4c892a87bd5e5f09c4d))


### Chores

* **internal/client:** fix form-urlencoded requests ([646cedd](https://github.com/openai/openai-node/commit/646cedd2842716b1768d81705110cc573d6ddc33))
* update mock server docs ([29f78f3](https://github.com/openai/openai-node/commit/29f78f310b7c336318705c382fd92a324d4b1ea2))


### Documentation

* **api:** document 2000 file limit in file-batches create parameters ([ff7bde0](https://github.com/openai/openai-node/commit/ff7bde08d8d02b8bda5f4e50bef65271a8f2a190))
* **api:** enhance method descriptions across audio/chat/skills/videos/responses ([f5e02a1](https://github.com/openai/openai-node/commit/f5e02a1dcad492fd3dab2d1a289c12af082cdef4))
* **api:** update safety_identifier description in chat/responses ([a55e0ef](https://github.com/openai/openai-node/commit/a55e0ef720cfb231e09e598ff0e8e60ef91e9088))

## 6.22.0 (2026-02-14)

Full Changelog: [v6.21.0...v6.22.0](https://github.com/openai/openai-node/compare/v6.21.0...v6.22.0)

### Features

* **api:** container network_policy and skills ([65c1482](https://github.com/openai/openai-node/commit/65c1482a41f16d39ff6ba26849a72b417b27403e))


### Bug Fixes

* **docs:** restore helper methods in API reference ([3a4c189](https://github.com/openai/openai-node/commit/3a4c189712292f280ca34326fe17e202180951bf))
* **webhooks:** restore webhook type exports ([49bbf46](https://github.com/openai/openai-node/commit/49bbf46f0ed14ce2a050d10baa4ad7a8481a773d))


### Chores

* **internal:** avoid type checking errors with ts-reset ([4b0d1f2](https://github.com/openai/openai-node/commit/4b0d1f27207dea6054291707d7bbdeb86dbcf4b2))


### Documentation

* split `api.md` by standalone resources ([48e07d6](https://github.com/openai/openai-node/commit/48e07d65894c22b543e669d62fa42a00cc3d0430))
* update comment ([e3a1ea0](https://github.com/openai/openai-node/commit/e3a1ea0400b428e0e21666f96e3a9345468678d5))

## 6.21.0 (2026-02-10)

Full Changelog: [v6.20.0...v6.21.0](https://github.com/openai/openai-node/compare/v6.20.0...v6.21.0)

### Features

* **api:** support for images in batch api ([017ba1c](https://github.com/openai/openai-node/commit/017ba1cb5a08428ca59197764cff460c70950e84))

## 6.20.0 (2026-02-10)

Full Changelog: [v6.19.0...v6.20.0](https://github.com/openai/openai-node/compare/v6.19.0...v6.20.0)

### Features

* **api:** skills and hosted shell ([e4bdd62](https://github.com/openai/openai-node/commit/e4bdd6205a0225d662ddeb07367f26094eaadbdd))

## 6.19.0 (2026-02-09)

Full Changelog: [v6.18.0...v6.19.0](https://github.com/openai/openai-node/compare/v6.18.0...v6.19.0)

### Features

* **api:** responses context_management ([40e7671](https://github.com/openai/openai-node/commit/40e7671675159966fe219b3aebfb24b9b03f2c95))

## 6.18.0 (2026-02-05)

Full Changelog: [v6.17.0...v6.18.0](https://github.com/openai/openai-node/compare/v6.17.0...v6.18.0)

### Features

* **api:** image generation actions for responses; ResponseFunctionCallArgumentsDoneEvent.name ([d373c32](https://github.com/openai/openai-node/commit/d373c3210d9299381e20520c217167b387b46105))


### Bug Fixes

* **client:** avoid memory leak with abort signals ([b449f36](https://github.com/openai/openai-node/commit/b449f36609b727f3f147fad19e8d064225bc8621))
* **client:** avoid removing abort listener too early ([1c045f7](https://github.com/openai/openai-node/commit/1c045f701743017ac7b4e2be0dfc8706a3b0213a))
* **client:** undo change to web search Find action ([8259b45](https://github.com/openai/openai-node/commit/8259b457c6f73c78066af0e1a76be0125caeb1ae))
* **client:** update type for `find_in_page` action ([9aa8d98](https://github.com/openai/openai-node/commit/9aa8d9822e60afb595c585f7be75087378b724bd))


### Chores

* **client:** do not parse responses with empty content-length ([4a118fa](https://github.com/openai/openai-node/commit/4a118fa3e09b0ad2bc4899b2a074fd60103796a0))
* **client:** restructure abort controller binding ([a4d7151](https://github.com/openai/openai-node/commit/a4d71518787849ec1f530da3c8550ea0f8746668))
* **internal:** fix pagination internals not accepting option promises ([6677905](https://github.com/openai/openai-node/commit/667790549f9160ba0cac484a8de09d8966cc13f0))

## 6.17.0 (2026-01-28)

Full Changelog: [v6.16.0...v6.17.0](https://github.com/openai/openai-node/compare/v6.16.0...v6.17.0)

### Features

* **api:** add shell_call_output status field ([edf9590](https://github.com/openai/openai-node/commit/edf95904294cce6cdcac521ee75dc8e0a033df4c))
* **api:** api update ([6a2eb80](https://github.com/openai/openai-node/commit/6a2eb80f53c21f52ff217faef9b783e1cf9846c1))
* **api:** api updates ([19ca100](https://github.com/openai/openai-node/commit/19ca100e9ebb2d03983da923c4bf944aa23c1f00))


### Bug Fixes

* **api:** mark assistants as deprecated ([3ae2a14](https://github.com/openai/openai-node/commit/3ae2a1439bc30d83c81e30ab30ddd06f91fee61f))


### Chores

* **ci:** upgrade `actions/github-script` ([4ea73d3](https://github.com/openai/openai-node/commit/4ea73d389b1b96d88c4c37c1a3a08ea143317c08))
* **internal:** update `actions/checkout` version ([f163b77](https://github.com/openai/openai-node/commit/f163b77bf2bb127f8049a0a7b1a2795c4f2bae50))
* **internal:** upgrade babel, qs, js-yaml ([2e2f3c6](https://github.com/openai/openai-node/commit/2e2f3c66ed61c0666e19831b123ea13d42978112))

## 6.16.0 (2026-01-09)

Full Changelog: [v6.15.0...v6.16.0](https://github.com/openai/openai-node/compare/v6.15.0...v6.16.0)

### Features

* **api:** add new Response completed_at prop ([ca40534](https://github.com/openai/openai-node/commit/ca40534778311def52bc7dbbab043d925cdaf847))
* **ci:** add breaking change detection workflow ([a6f3dea](https://github.com/openai/openai-node/commit/a6f3deaf89ea0ef85cc57e1150032bb6b807c3b9))


### Chores

* break long lines in snippets into multiline ([80dee2f](https://github.com/openai/openai-node/commit/80dee2fe64d1b13f181bd482b31eb06fd6c5f3f4))
* **internal:** codegen related update ([b2fac3e](https://github.com/openai/openai-node/commit/b2fac3ecdc3aecc3303c26304c4c94deda061edb))

## 6.15.0 (2025-12-19)

Full Changelog: [v6.14.0...v6.15.0](https://github.com/openai/openai-node/compare/v6.14.0...v6.15.0)

### Bug Fixes

* rebuild ([5627b41](https://github.com/openai/openai-node/commit/5627b4181775981e48991ea246e091afdfdc3caf))

## 6.14.0 (2025-12-16)

Full Changelog: [v6.13.0...v6.14.0](https://github.com/openai/openai-node/compare/v6.13.0...v6.14.0)

### Features

* **api:** gpt-image-1.5 ([6c1ac1d](https://github.com/openai/openai-node/commit/6c1ac1d8a2947c59f38aabaf07795a244c45a688))

## 6.13.0 (2025-12-15)

Full Changelog: [v6.12.0...v6.13.0](https://github.com/openai/openai-node/compare/v6.12.0...v6.13.0)

### Features

* **api:** api update ([bc759dc](https://github.com/openai/openai-node/commit/bc759dc39518412b58b2ebf7e57758776971ce15))
* **api:** fix grader input list, add dated slugs for sora-2 ([6b2a38f](https://github.com/openai/openai-node/commit/6b2a38fb040eb45535818fb0157ae55949033dc1))

## 6.12.0 (2025-12-11)

Full Changelog: [v6.11.0...v6.12.0](https://github.com/openai/openai-node/compare/v6.11.0...v6.12.0)

### Features

* **api:** gpt 5.2 ([7000ddb](https://github.com/openai/openai-node/commit/7000ddb09ad4e272f43fe0d70cb1f6e5ca9ff725))

## 6.11.0 (2025-12-10)

Full Changelog: [v6.10.0...v6.11.0](https://github.com/openai/openai-node/compare/v6.10.0...v6.11.0)

### Features

* **api:** make model required for the responses/compact endpoint ([0b52b12](https://github.com/openai/openai-node/commit/0b52b12e535b07ef3b1213892ccb50dc4030ecf4))


### Bug Fixes

* **mcp:** correct code tool API endpoint ([e3f2a33](https://github.com/openai/openai-node/commit/e3f2a33bc7ae941d0870e7bc0a333951e88925e2))
* **mcp:** return correct lines on typescript errors ([f485c3c](https://github.com/openai/openai-node/commit/f485c3c36ebb3cb9c2dbff676872a5470d1a9e47))


### Chores

* **internal:** codegen related update ([5af1c38](https://github.com/openai/openai-node/commit/5af1c38043118fd8e6f0fd072243bc63660963e4))
* **internal:** codegen related update ([e43a8d9](https://github.com/openai/openai-node/commit/e43a8d97fd3e9be7c6ae0ebaf6e85d68dbb33432))

## 6.10.0 (2025-12-04)

Full Changelog: [v6.9.1...v6.10.0](https://github.com/openai/openai-node/compare/v6.9.1...v6.10.0)

### Features

* **api:** gpt-5.1-codex-max and responses/compact ([935f79e](https://github.com/openai/openai-node/commit/935f79efbb090d1d6016ac6874456594f5fd4553))


### Chores

* **client:** fix logger property type ([fdc671f](https://github.com/openai/openai-node/commit/fdc671f1b21249a8610b38e2535910d956dc3611))
* **internal:** upgrade eslint ([9de0f90](https://github.com/openai/openai-node/commit/9de0f905bbd965a5d945ddb70c66dc0c6403ed35))

## 6.9.1 (2025-11-17)

Full Changelog: [v6.9.0...v6.9.1](https://github.com/openai/openai-node/compare/v6.9.0...v6.9.1)

### Bug Fixes

* **api:** align types of input items / output items for typescript ([99adaa7](https://github.com/openai/openai-node/commit/99adaa70dc31d07d5c7fa4d67194ac4de375c98f))

## 6.9.0 (2025-11-13)

Full Changelog: [v6.8.1...v6.9.0](https://github.com/openai/openai-node/compare/v6.8.1...v6.9.0)

### Features

* **api:** gpt 5.1 ([58e78a8](https://github.com/openai/openai-node/commit/58e78a86899b43eb9afdb6f0afd60b912eae41f2))


### Chores

* add typescript-estree dependency for jsr readme script ([3759514](https://github.com/openai/openai-node/commit/37595149720edd7bf4c11760084cad7753c2f289))

## 6.8.1 (2025-11-05)

Full Changelog: [v6.8.0...v6.8.1](https://github.com/openai/openai-node/compare/v6.8.0...v6.8.1)

### Bug Fixes

* **api:** fix nullability of logprobs ([40a403c](https://github.com/openai/openai-node/commit/40a403cc9a35b11cc665ccde19f9c5ef07247585))

## 6.8.0 (2025-11-03)

Full Changelog: [v6.7.0...v6.8.0](https://github.com/openai/openai-node/compare/v6.7.0...v6.8.0)

### Features

* **api:** Realtime API token_limits, Hybrid searching ranking options ([6a5b48c](https://github.com/openai/openai-node/commit/6a5b48c9c8961bc7409c20546d9d845a4f2674ce))
* **api:** remove InputAudio from ResponseInputContent ([9909fef](https://github.com/openai/openai-node/commit/9909fef596280fc16174679d97c3e81543c68646))


### Chores

* **internal:** codegen related update ([3ad52aa](https://github.com/openai/openai-node/commit/3ad52aaa94cdbe1926fee1e5f8eacebefdfc399d))

## 6.7.0 (2025-10-24)

Full Changelog: [v6.6.0...v6.7.0](https://github.com/openai/openai-node/compare/v6.6.0...v6.7.0)

### Features

* add support for zod@4 schemas ([#1666](https://github.com/openai/openai-node/issues/1666)) ([10ef7ff](https://github.com/openai/openai-node/commit/10ef7ff4cb4aefeaa831b239943118ff52872f5c))


### Bug Fixes

* **api:** docs updates ([2591c21](https://github.com/openai/openai-node/commit/2591c211bce29d078579445d9a3b45d8de453ec3))

## 6.6.0 (2025-10-20)

Full Changelog: [v6.5.0...v6.6.0](https://github.com/openai/openai-node/compare/v6.5.0...v6.6.0)

### Features

* **api:** Add responses.input_tokens.count ([520c8a9](https://github.com/openai/openai-node/commit/520c8a95c857307b9329c4725cb40707d4e3eeee))


### Bug Fixes

* **api:** internal openapi updates ([d4aaef9](https://github.com/openai/openai-node/commit/d4aaef9c2e3d9f00b33d59e569149a937e5bd3f5))

## 6.5.0 (2025-10-17)

Full Changelog: [v6.4.0...v6.5.0](https://github.com/openai/openai-node/compare/v6.4.0...v6.5.0)

### Features

* **api:** api update ([4d21af3](https://github.com/openai/openai-node/commit/4d21af3e6a04baa0ea42d360cf3601fcc3d39705))

## 6.4.0 (2025-10-16)

Full Changelog: [v6.3.0...v6.4.0](https://github.com/openai/openai-node/compare/v6.3.0...v6.4.0)

### Features

* **api:** Add support for gpt-4o-transcribe-diarize on audio/transcriptions endpoint ([2d27392](https://github.com/openai/openai-node/commit/2d27392ac1cd082f7defb730326d11d8e733353f))

## 6.3.0 (2025-10-10)

Full Changelog: [v6.2.0...v6.3.0](https://github.com/openai/openai-node/compare/v6.2.0...v6.3.0)

### Features

* **api:** comparison filter in/not in ([1a733c6](https://github.com/openai/openai-node/commit/1a733c69ffff094568707b3f615d110c7e2edd6e))


### Chores

* **internal:** use npm pack for build uploads ([a532410](https://github.com/openai/openai-node/commit/a53241032e1177a390337986399da57e39be25ec))

## 6.2.0 (2025-10-06)

Full Changelog: [v6.1.0...v6.2.0](https://github.com/openai/openai-node/compare/v6.1.0...v6.2.0)

### Features

* **api:** dev day 2025 launches ([f2816db](https://github.com/openai/openai-node/commit/f2816dbc6ae162d39017e7bafb0d23d0b51dd585))


### Chores

* **internal:** codegen related update ([b6f64b7](https://github.com/openai/openai-node/commit/b6f64b70ea681b174695d930f957aa49194553ed))
* **jsdoc:** fix [@link](https://github.com/link) annotations to refer only to parts of the package‘s public interface ([73e465d](https://github.com/openai/openai-node/commit/73e465d382a45389ab47a0a92575e4415e8d3276))

## 6.1.0 (2025-10-02)

Full Changelog: [v6.0.1...v6.1.0](https://github.com/openai/openai-node/compare/v6.0.1...v6.1.0)

### Features

* **api:** add support for realtime calls ([5de9585](https://github.com/openai/openai-node/commit/5de958556679182dfbdce95b4db6b65ca742aa61))

## 6.0.1 (2025-10-01)

Full Changelog: [v6.0.0...v6.0.1](https://github.com/openai/openai-node/compare/v6.0.0...v6.0.1)

### Bug Fixes

* **api:** add status, approval_request_id to MCP tool call ([498c6a5](https://github.com/openai/openai-node/commit/498c6a5d4cab7ad10e31acd01cb49915a70e576a))

## 6.0.0 (2025-09-30)

Full Changelog: [v5.23.2...v6.0.0](https://github.com/openai/openai-node/compare/v5.23.2...v6.0.0)

### ⚠ BREAKING CHANGES

* **api:** `ResponseFunctionToolCallOutputItem.output` and `ResponseCustomToolCallOutput.output` now return `string | Array<ResponseInputText | ResponseInputImage | ResponseInputFile>` instead of `string` only. This may break existing callsites that assume `output` is always a string.

### Features

* **api:** Support images and files for function call outputs in responses, BatchUsage ([abe56f8](https://github.com/openai/openai-node/commit/abe56f86afdf28fc1a1b410ace1dd422672361a7))


### Chores

* compat with zod v4 ([#1658](https://github.com/openai/openai-node/issues/1658)) ([94569a0](https://github.com/openai/openai-node/commit/94569a07ce55317b0166e742b90a463df0f70e56))

## 5.23.2 (2025-09-29)

Full Changelog: [v5.23.1...v5.23.2](https://github.com/openai/openai-node/compare/v5.23.1...v5.23.2)

### Chores

* **env-tests:** upgrade jest-fixed-jsdom 0.0.9 -&gt; 0.0.10 ([6d6d0b0](https://github.com/openai/openai-node/commit/6d6d0b0eaaff86a99141af031f55b7cc6a22772a))
* **internal:** codegen related update ([1b684af](https://github.com/openai/openai-node/commit/1b684afd387ccd7b16d226dca3adee92db6e4878))
* **internal:** ignore .eslintcache ([da9e146](https://github.com/openai/openai-node/commit/da9e1468d62aa9044ee9d236b419f744f8792bdb))

## 5.23.1 (2025-09-26)

Full Changelog: [v5.23.0...v5.23.1](https://github.com/openai/openai-node/compare/v5.23.0...v5.23.1)

### Bug Fixes

* **realtime:** remove beta header from GA classes ([a5e9e70](https://github.com/openai/openai-node/commit/a5e9e70af8691f2850ad7ccfec966e5fb0d5b56d))


### Performance Improvements

* faster formatting ([d56f309](https://github.com/openai/openai-node/commit/d56f309f359f7f4d87c95bfaaffdc463312850e4))


### Chores

* **internal:** fix incremental formatting in some cases ([166d28f](https://github.com/openai/openai-node/commit/166d28ff34edb6b1c3ef310bc825952dcb30ba4b))
* **internal:** remove deprecated `compilerOptions.baseUrl` from tsconfig.json ([dfab408](https://github.com/openai/openai-node/commit/dfab40857547b272cdad4309baf84e43a07775ed))

## 5.23.0 (2025-09-23)

Full Changelog: [v5.22.1...v5.23.0](https://github.com/openai/openai-node/compare/v5.22.1...v5.23.0)

### Features

* **api:** gpt-5-codex ([2e4ece6](https://github.com/openai/openai-node/commit/2e4ece6a01e1b7c4c69627137900b7f70558a85b))

## 5.22.1 (2025-09-22)

Full Changelog: [v5.22.0...v5.22.1](https://github.com/openai/openai-node/compare/v5.22.0...v5.22.1)

### Bug Fixes

* **api:** fix mcp tool name ([fa9f305](https://github.com/openai/openai-node/commit/fa9f3055c63f83ddc19085ebeb7ac38cb303673a))


### Chores

* **api:** openapi updates for conversations ([975c075](https://github.com/openai/openai-node/commit/975c0757da3474439d166a27d61ba6606d439bb0))
* do not install brew dependencies in ./scripts/bootstrap by default ([6f5e45f](https://github.com/openai/openai-node/commit/6f5e45fc8a0c2dee1f68d00b135034653ed23200))
* improve example values ([b336a64](https://github.com/openai/openai-node/commit/b336a642fd9507bf28e0ed8976ec102d796f9b9d))

## 5.22.0 (2025-09-19)

Full Changelog: [v5.21.0...v5.22.0](https://github.com/openai/openai-node/compare/v5.21.0...v5.22.0)

### Features

* **api:** add reasoning_text ([7ff6186](https://github.com/openai/openai-node/commit/7ff61860a14ae20d0734b4f592002dfe67330488))


### Chores

* **api:** manual fixes for streaming ([3a2ae4c](https://github.com/openai/openai-node/commit/3a2ae4ce2a0796f5201dd9373f103bd94689b733))

## 5.21.0 (2025-09-17)

Full Changelog: [v5.20.3...v5.21.0](https://github.com/openai/openai-node/compare/v5.20.3...v5.21.0)

### Features

* **api:** type updates for conversations, reasoning_effort and results for evals ([f243f54](https://github.com/openai/openai-node/commit/f243f54072d00cb8d83b8c6093accaaabf34d4cf))

## 5.20.3 (2025-09-15)

Full Changelog: [v5.20.2...v5.20.3](https://github.com/openai/openai-node/compare/v5.20.2...v5.20.3)

### Chores

* **api:** docs and spec refactoring ([05b4498](https://github.com/openai/openai-node/commit/05b44987c699f7683b8706c8de363165150e5f31))

## 5.20.2 (2025-09-12)

Full Changelog: [v5.20.1...v5.20.2](https://github.com/openai/openai-node/compare/v5.20.1...v5.20.2)

### Bug Fixes

* coerce nullable values to undefined ([836d1b4](https://github.com/openai/openai-node/commit/836d1b4cdd077c206e1c647c762f4c16e9db444c))


### Chores

* **api:** Minor docs and type updates for realtime ([ccb00dc](https://github.com/openai/openai-node/commit/ccb00dcbd1466976045aafee152cbc038bb293b9))

## 5.20.1 (2025-09-10)

Full Changelog: [v5.20.0...v5.20.1](https://github.com/openai/openai-node/compare/v5.20.0...v5.20.1)

### Chores

* **api:** fix realtime GA types ([1c0d314](https://github.com/openai/openai-node/commit/1c0d3145e920a55f3c710323849bcac1fd60b703))

## 5.20.0 (2025-09-08)

Full Changelog: [v5.19.1...v5.20.0](https://github.com/openai/openai-node/compare/v5.19.1...v5.20.0)

### Features

* **api:** ship the RealtimeGA API shape ([4286ddd](https://github.com/openai/openai-node/commit/4286ddd4f990dd26e15e510039457f17d787820d))


### Chores

* ci build action ([c8ce143](https://github.com/openai/openai-node/commit/c8ce143196fdbc7ee1c7832bce2417b6e3d25885))

## 5.19.1 (2025-09-03)

Full Changelog: [v5.19.0...v5.19.1](https://github.com/openai/openai-node/compare/v5.19.0...v5.19.1)

### Bug Fixes

* **azure:** correctly send API key ([#1635](https://github.com/openai/openai-node/issues/1635)) ([08f6178](https://github.com/openai/openai-node/commit/08f6178ff0d4ccc6b80462c86a36f11eb3bfd5fe))

## 5.19.0 (2025-09-03)

Full Changelog: [v5.18.1...v5.19.0](https://github.com/openai/openai-node/compare/v5.18.1...v5.19.0)

### Features

* **api:** Add gpt-realtime models ([256d932](https://github.com/openai/openai-node/commit/256d93247da7f31e34f5f80d8added0bc6f52fe9))

## 5.18.1 (2025-09-02)

Full Changelog: [v5.18.0...v5.18.1](https://github.com/openai/openai-node/compare/v5.18.0...v5.18.1)

### Chores

* **api:** manual updates for ResponseInputAudio ([570501b](https://github.com/openai/openai-node/commit/570501b8c66f3f23d0dca05bc948339623732a8e))

## 5.18.0 (2025-09-02)

Full Changelog: [v5.17.0...v5.18.0](https://github.com/openai/openai-node/compare/v5.17.0...v5.18.0)

### Features

* **client:** support api key provider functions ([#1587](https://github.com/openai/openai-node/issues/1587)) ([c3a92c7](https://github.com/openai/openai-node/commit/c3a92c7ee6f5f7c26c9297be04343326c9854bfd))


### Bug Fixes

* update non beta realtime websockets helpers ([265a42f](https://github.com/openai/openai-node/commit/265a42f9101b0479b7d8dcbf05d45ce29539a7f3))

## 5.17.0 (2025-09-02)

Full Changelog: [v5.16.0...v5.17.0](https://github.com/openai/openai-node/compare/v5.16.0...v5.17.0)

### Features

* **api:** realtime API updates ([e817255](https://github.com/openai/openai-node/commit/e817255e6ff9e3ad6bd08b001644c335e0459537))


### Chores

* **internal:** update global Error reference ([e566ff3](https://github.com/openai/openai-node/commit/e566ff321642a100756224b75a67d44e262e5bea))

## 5.16.0 (2025-08-26)

Full Changelog: [v5.15.0...v5.16.0](https://github.com/openai/openai-node/compare/v5.15.0...v5.16.0)

### Features

* **api:** add web search filters ([975b141](https://github.com/openai/openai-node/commit/975b1417052bdcc0111f546ce3fbbea2e71414af))


### Chores

* **client:** qualify global Blob ([7998d3f](https://github.com/openai/openai-node/commit/7998d3fd3715ab2c06ea011155420ac126681649))
* update CI script ([accb0c1](https://github.com/openai/openai-node/commit/accb0c1188dbaef20c1a40bd3047087960c99a07))

## 5.15.0 (2025-08-21)

Full Changelog: [v5.14.0...v5.15.0](https://github.com/openai/openai-node/compare/v5.14.0...v5.15.0)

### Features

* **api:** Add connectors support for MCP tool ([048bee3](https://github.com/openai/openai-node/commit/048bee3693822c75181012c47b4f54074e1efdd6))
* **api:** adding support for /v1/conversations to the API ([1380d17](https://github.com/openai/openai-node/commit/1380d1734b1e7eeb5d10fb73fe9cfce6199e5c8e))


### Chores

* add package to package.json ([6748b2b](https://github.com/openai/openai-node/commit/6748b2b64f6c06ee324694b95ae7df99493ff08d))

## 5.14.0 (2025-08-20)

Full Changelog: [v5.13.1...v5.14.0](https://github.com/openai/openai-node/compare/v5.13.1...v5.14.0)

### Features

* **mcp:** add code execution tool ([3f8264c](https://github.com/openai/openai-node/commit/3f8264cfaafb8d03aedabe53a0d17a7e3dc326d8))


### Chores

* **internal/ci:** setup breaking change detection ([87e8004](https://github.com/openai/openai-node/commit/87e8004d05eb27d14a11d433239af525c9c493b9))

## 5.13.1 (2025-08-19)

Full Changelog: [v5.13.0...v5.13.1](https://github.com/openai/openai-node/compare/v5.13.0...v5.13.1)

### Chores

* **api:** accurately represent shape for verbosity on Chat Completions ([5ddac3c](https://github.com/openai/openai-node/commit/5ddac3c7535e2df4b562fe1237b639e112bf5eef))

## 5.13.0 (2025-08-18)

Full Changelog: [v5.12.3...v5.13.0](https://github.com/openai/openai-node/compare/v5.12.3...v5.13.0)

### Features

* **api:** add new text parameters, expiration options ([499179c](https://github.com/openai/openai-node/commit/499179c095eae77dcccec5e2758ab72c8d829ea7))


### Chores

* **deps:** update dependency @types/node to v20.17.58 ([7812d0d](https://github.com/openai/openai-node/commit/7812d0db43309144cb46714a64fe97a3e12f5b04))
* **internal:** formatting change ([56b2073](https://github.com/openai/openai-node/commit/56b2073ac3553d6b9cca1185fe52a7e697d0b733))

## 5.12.3 (2025-08-12)

Full Changelog: [v5.12.2...v5.12.3](https://github.com/openai/openai-node/compare/v5.12.2...v5.12.3)

### Chores

* **internal:** update comment in script ([2488faf](https://github.com/openai/openai-node/commit/2488faf387da1c9bd7565d4bb5aded7bb53b8799))
* update @stainless-api/prism-cli to v5.15.0 ([db44a7d](https://github.com/openai/openai-node/commit/db44a7d2afa4e0330f4981c106f9abf2fd4ab432))

## 5.12.2 (2025-08-08)

Full Changelog: [v5.12.1...v5.12.2](https://github.com/openai/openai-node/compare/v5.12.1...v5.12.2)

### Bug Fixes

* **client:** fix verbosity parameter location in Responses ([eaa246f](https://github.com/openai/openai-node/commit/eaa246ffe00ffcdec45c695a96aeed3d87bb3f74))

## 5.12.1 (2025-08-07)

Full Changelog: [v5.12.0...v5.12.1](https://github.com/openai/openai-node/compare/v5.12.0...v5.12.1)

### Features

* **api:** adds GPT-5 and new API features: platform.openai.com/docs/guides/gpt-5 ([59acd85](https://github.com/openai/openai-node/commit/59acd85a3e0d4db7f7eca9a287b23ec00191fa68))


### Chores

* **internal:** move publish config ([b3d02f6](https://github.com/openai/openai-node/commit/b3d02f6faab5aa8e62998446485e43ebc802d68e))

## 5.12.0 (2025-08-05)

Full Changelog: [v5.11.0...v5.12.0](https://github.com/openai/openai-node/compare/v5.11.0...v5.12.0)

### Features

* **api:** manual updates ([f0d3056](https://github.com/openai/openai-node/commit/f0d3056932adb8e448fd1141eae4b07ad0c66ddb))

## 5.11.0 (2025-07-30)

Full Changelog: [v5.10.3...v5.11.0](https://github.com/openai/openai-node/compare/v5.10.3...v5.11.0)

### Features

* **api:** manual updates ([442dc25](https://github.com/openai/openai-node/commit/442dc25d7b31a374daf440f32f5694c3b6c20a81))

## 5.10.3 (2025-07-30)

Full Changelog: [v5.10.2...v5.10.3](https://github.com/openai/openai-node/compare/v5.10.2...v5.10.3)

### Bug Fixes

* **zod:** avoid adding redundant not to optional schemas [#1593](https://github.com/openai/openai-node/issues/1593) ([162b697](https://github.com/openai/openai-node/commit/162b697d1b946dc4af213c8efcdb7a7b5317bb6e))


### Chores

* **client:** refactor streaming slightly to better future proof it ([292427f](https://github.com/openai/openai-node/commit/292427f7f39f6dd64e46ba4360b0b96c8e49adc9))
* **internal:** remove redundant imports config ([28dd66d](https://github.com/openai/openai-node/commit/28dd66de15032d6ee620d3cf9f3e33ba61cad4e7))
* **internal:** version bump ([56e0760](https://github.com/openai/openai-node/commit/56e076090a9ce5c6b7f4ac4d84d33ca3f6522973))

## 5.10.2 (2025-07-22)

Full Changelog: [v5.10.1...v5.10.2](https://github.com/openai/openai-node/compare/v5.10.1...v5.10.2)

### Chores

* **api:** event shapes more accurate ([78f4e1d](https://github.com/openai/openai-node/commit/78f4e1d8e7400001a7bc6a05dc9a6e52a2047523))
* **internal:** version bump ([ea885ca](https://github.com/openai/openai-node/commit/ea885cac5c4231597141e91bd454e540830deb95))


### Documentation

* fix typos in helpers and realtime ([#1592](https://github.com/openai/openai-node/issues/1592)) ([17733b7](https://github.com/openai/openai-node/commit/17733b7e4a19754c9ca2ec815cf7d246b1dc138d))

## 5.10.1 (2025-07-16)

Full Changelog: [v5.10.0...v5.10.1](https://github.com/openai/openai-node/compare/v5.10.0...v5.10.1)

### Chores

* **internal:** version bump ([896b418](https://github.com/openai/openai-node/commit/896b41828ce468fed36ceb50082633e21a0945ca))
* **ts:** reorder package.json imports ([2f8d2f7](https://github.com/openai/openai-node/commit/2f8d2f7726dbc717c3c6e2a27dbd5b50ff9ef4b4))

## 5.10.0 (2025-07-16)

Full Changelog: [v5.9.2...v5.10.0](https://github.com/openai/openai-node/compare/v5.9.2...v5.10.0)

### Features

* **api:** manual updates ([35338b4](https://github.com/openai/openai-node/commit/35338b44ace44f0f0c0b48ea94aa96d3c81ea385))


### Chores

* **internal:** version bump ([3d9de4b](https://github.com/openai/openai-node/commit/3d9de4b2f28c80ea1f92446c092b23d69955ef30))

## 5.9.2 (2025-07-15)

Full Changelog: [v5.9.1...v5.9.2](https://github.com/openai/openai-node/compare/v5.9.1...v5.9.2)

### Chores

* **api:** update realtime specs ([4a20a3d](https://github.com/openai/openai-node/commit/4a20a3da8319667540a7b120f0f94e253420058e))
* **internal:** version bump ([103e8de](https://github.com/openai/openai-node/commit/103e8def71408724fb37104cfcb9419e01022f24))

## 5.9.1 (2025-07-15)

Full Changelog: [v5.9.0...v5.9.1](https://github.com/openai/openai-node/compare/v5.9.0...v5.9.1)

### Chores

* **api:** update realtime specs, build config ([bb4649f](https://github.com/openai/openai-node/commit/bb4649feb69a6d91e4eea857fd6f5e8c00f2a35d))

## 5.9.0 (2025-07-10)

Full Changelog: [v5.8.4...v5.9.0](https://github.com/openai/openai-node/compare/v5.8.4...v5.9.0)

### Features

* **api:** add file_url, fix event ID ([5f5d39e](https://github.com/openai/openai-node/commit/5f5d39e9e11224bf18a0301041b69548727ed4f3))

## 5.8.4 (2025-07-10)

Full Changelog: [v5.8.3...v5.8.4](https://github.com/openai/openai-node/compare/v5.8.3...v5.8.4)

### Chores

* **internal:** bump undici version in tests ([6f38b80](https://github.com/openai/openai-node/commit/6f38b809a69b6ab3fcbf1235e57bdb8912024ab3))
* make some internal functions async ([841940d](https://github.com/openai/openai-node/commit/841940d2ae036191b456e8398fbcb1f24c6e4deb))

## 5.8.3 (2025-07-08)

Full Changelog: [v5.8.2...v5.8.3](https://github.com/openai/openai-node/compare/v5.8.2...v5.8.3)

### Bug Fixes

* avoid console usage ([aec57c5](https://github.com/openai/openai-node/commit/aec57c5902b47d2d643f48d98a6014e0e77ba6cc))


### Chores

* add docs to RequestOptions type ([3735172](https://github.com/openai/openai-node/commit/37351723bc5a24c06a96c95e11104cda42a1bec3))
* **ci:** only run for pushes and fork pull requests ([e200bc4](https://github.com/openai/openai-node/commit/e200bc4db18a09d4148fff0056801140411bfa53))
* **client:** improve path param validation ([b5a043b](https://github.com/openai/openai-node/commit/b5a043bc96b6b6bfe8cca05e103a6e4d6fea962b))
* **internal/tests:** pin bun types version ([fcffa88](https://github.com/openai/openai-node/commit/fcffa880c1b31aeca70a6fa093f4b1f9d3db1a74))

## 5.8.2 (2025-06-27)

Full Changelog: [v5.8.1...v5.8.2](https://github.com/openai/openai-node/compare/v5.8.1...v5.8.2)

### Bug Fixes

* **client:** get fetchOptions type more reliably ([b3c959d](https://github.com/openai/openai-node/commit/b3c959d22d1002a85772385476f9a5098c8e1514))

## 5.8.1 (2025-06-26)

Full Changelog: [v5.8.0...v5.8.1](https://github.com/openai/openai-node/compare/v5.8.0...v5.8.1)

### Bug Fixes

* **client:** ensure addOutputText is called on responses.retrieve ([d55bb64](https://github.com/openai/openai-node/commit/d55bb64f8022c1e861b4b4d1c23ad4cc0e80e536))


### Chores

* **api:** remove unsupported property ([1966954](https://github.com/openai/openai-node/commit/19669545157dc0339f4c88855bd1ae9acaaac53d))
* **docs:** update README to include links to docs on Webhooks ([586d5da](https://github.com/openai/openai-node/commit/586d5daf5babc9f12793201f1e1e4c79829151f0))
* **webhooks:** make private methods really private ([0ee396a](https://github.com/openai/openai-node/commit/0ee396a2a0e03c794c7cfa3c9f1beb848fd77f1d))

## 5.8.0 (2025-06-26)

Full Changelog: [v5.7.0...v5.8.0](https://github.com/openai/openai-node/compare/v5.7.0...v5.8.0)

### Features

* **api:** webhook and deep research support ([f2b4f66](https://github.com/openai/openai-node/commit/f2b4f66226ad514d702f8acbb4820ae90b4fd40e))


### Bug Fixes

* **ci:** release-doctor — report correct token name ([aed2587](https://github.com/openai/openai-node/commit/aed2587294922415aeaece0b9a6911c3e1577c51))


### Refactors

* **types:** replace Record with mapped types ([7865910](https://github.com/openai/openai-node/commit/7865910c7d66a14dac70ea119e109975d9169414))

## 5.7.0 (2025-06-23)

Full Changelog: [v5.6.0...v5.7.0](https://github.com/openai/openai-node/compare/v5.6.0...v5.7.0)

### Features

* **api:** update api shapes for usage and code interpreter ([f2100e8](https://github.com/openai/openai-node/commit/f2100e89334753e7f580f7f20f48b43eb8ba2fe3))

## 5.6.0 (2025-06-20)

Full Changelog: [v5.5.1...v5.6.0](https://github.com/openai/openai-node/compare/v5.5.1...v5.6.0)

### Features

* **api:** make model and inputs not required to create response ([52211c0](https://github.com/openai/openai-node/commit/52211c0e67c2926b27f4adee1f626066d90b6a2e))


### Bug Fixes

* **client:** explicitly copy fetch in withOptions ([0efacae](https://github.com/openai/openai-node/commit/0efacaeb8eb0bfbad6bd6bc29fc57f00916411c0))


### Chores

* **readme:** update badges ([6898954](https://github.com/openai/openai-node/commit/689895400adf38e85810ba8b63dc16ed56839ddd))
* **readme:** use better example snippet for undocumented params ([668611f](https://github.com/openai/openai-node/commit/668611f4331ffa375257f3bc138c54d6ee965cd6))

## 5.5.1 (2025-06-17)

Full Changelog: [v5.5.0...v5.5.1](https://github.com/openai/openai-node/compare/v5.5.0...v5.5.1)

### Chores

* **ci:** enable for pull requests ([e1cf00c](https://github.com/openai/openai-node/commit/e1cf00cf2a2ce832d759f3253f10826d3c16338e))

## 5.5.0 (2025-06-16)

Full Changelog: [v5.4.0...v5.5.0](https://github.com/openai/openai-node/compare/v5.4.0...v5.5.0)

### Features

* **api:** manual updates ([ab6b57c](https://github.com/openai/openai-node/commit/ab6b57c241dc7c57e411fae572842da801e9828b))

## 5.4.0 (2025-06-16)

Full Changelog: [v5.3.0...v5.4.0](https://github.com/openai/openai-node/compare/v5.3.0...v5.4.0)

### Features

* **api:** add reusable prompt IDs ([c720bb3](https://github.com/openai/openai-node/commit/c720bb3fb909cdef1cc679df38357f046d3d2756))
* **client:** add support for endpoint-specific base URLs ([05f558b](https://github.com/openai/openai-node/commit/05f558bcdd362ae56000fe515a24593363d59e83))


### Bug Fixes

* publish script — handle NPM errors correctly ([a803cce](https://github.com/openai/openai-node/commit/a803cce6d44116eaba34f2bd7cb0f5d8f5c72be8))


### Chores

* **client:** refactor imports ([9eb4470](https://github.com/openai/openai-node/commit/9eb44703432d7e22290564013f8e1798c82918a3))
* **internal:** add pure annotations, make base APIResource abstract ([418eb02](https://github.com/openai/openai-node/commit/418eb02e3ebe3ef58d851405f9eb5cae275194b4))

## 5.3.0 (2025-06-10)

Full Changelog: [v5.2.0...v5.3.0](https://github.com/openai/openai-node/compare/v5.2.0...v5.3.0)

### Features

* **api:** Add o3-pro model IDs ([9988f8e](https://github.com/openai/openai-node/commit/9988f8ea50a370abfc03bc97882d1ddd83837217))

## 5.2.0 (2025-06-09)

Full Changelog: [v5.1.1...v5.2.0](https://github.com/openai/openai-node/compare/v5.1.1...v5.2.0)

### Features

* **api:** Add tools and structured outputs to evals ([64844f1](https://github.com/openai/openai-node/commit/64844f1be2da9658a603fac304d1387f28a110a4))


### Bug Fixes

* **changelog:** remove duplicated entries ([18484cc](https://github.com/openai/openai-node/commit/18484cceea615a01b62590b9b626b9e2140c7dd9))


### Chores

* avoid type error in certain environments ([44ac3d9](https://github.com/openai/openai-node/commit/44ac3d96eb258cd777edb02004763ccef253ae7a))


### Documentation

* **changelog:** reference MIGRATION.md ([b3d488f](https://github.com/openai/openai-node/commit/b3d488feff5acb020f5db6f27ea94884c56bc767)), closes [#1539](https://github.com/openai/openai-node/issues/1539)

## 5.1.1 (2025-06-05)

Full Changelog: [v5.1.0...v5.1.1](https://github.com/openai/openai-node/compare/v5.1.0...v5.1.1)

### Bug Fixes

* **assistants:** handle thread.run.incomplete while streaming ([8f5e7f3](https://github.com/openai/openai-node/commit/8f5e7f3ffaad7bdd0424743eb68a63f918dbabb8))


### Chores

* **docs:** use top-level-await in example snippets ([065d3b0](https://github.com/openai/openai-node/commit/065d3b08b29e10d7af58bb66816245f71f386833))
* **internal:** fix readablestream types in node 20 ([771ae81](https://github.com/openai/openai-node/commit/771ae818c32d855778c3847d9005efb80b0a8cd5))

## 5.1.0 (2025-06-03)

Full Changelog: [v5.0.2...v5.1.0](https://github.com/openai/openai-node/compare/v5.0.2...v5.1.0)

### Features

* **api:** add new realtime and audio models, realtime session options ([1219f09](https://github.com/openai/openai-node/commit/1219f090b02b8d53f29abf5a0e7564af0f9f68fc))


### Chores

* adjust eslint.config.mjs ignore pattern ([9b5c898](https://github.com/openai/openai-node/commit/9b5c898fe5099859252d3c3fd62010d6aa552fef))
* **api:** update type names ([7c296d6](https://github.com/openai/openai-node/commit/7c296d62bbde52ec84e3af78ed12f1cd196f9d52))

## 5.0.2 (2025-06-02)

Full Changelog: [v5.0.1...v5.0.2](https://github.com/openai/openai-node/compare/v5.0.1...v5.0.2)

### Bug Fixes

* **api:** Fix evals and code interpreter interfaces ([992a9d8](https://github.com/openai/openai-node/commit/992a9d84fe412d96496b11b7a6be5c927f78db6c))


### Chores

* **deps:** bump eslint-plugin-prettier ([1428a8b](https://github.com/openai/openai-node/commit/1428a8b4f82e79695c2cbed5e12ca0da4958423b))
* **internal:** codegen related update ([a65428f](https://github.com/openai/openai-node/commit/a65428fc81e05f681eab806e7efc6ad26062221b))

## 5.0.1 (2025-05-29)

Full Changelog: [v5.0.0...v5.0.1](https://github.com/openai/openai-node/compare/v5.0.0...v5.0.1)

### Chores

* sync changes ([90b100d](https://github.com/openai/openai-node/commit/90b100dcf504ecf0b98620702cb6bd0988695320))
* **types:** add missing type annotation ([de37b55](https://github.com/openai/openai-node/commit/de37b55e6e95d7089ee845d4144883d93bb18ca0))

## 5.0.0 (2025-05-29)

This release migrates from node-fetch to builtin fetch, for full release notes see [MIGRATION.md](https://github.com/openai/openai-node/blob/master/MIGRATION.md).

Full Changelog: [v5.0.0-alpha.0...v5.0.0](https://github.com/openai/openai-node/compare/v5.0.0-alpha.0...v5.0.0)

### Features

* add audio helpers ([ec5067d](https://github.com/openai/openai-node/commit/ec5067deba1fe4202d90db42e45c3bd774936af1))
* add migration guide ([cfd2088](https://github.com/openai/openai-node/commit/cfd2088219464381077dec62d38d1830ab0b43f3))
* add SKIP_BREW env var to ./scripts/bootstrap ([7ea4a24](https://github.com/openai/openai-node/commit/7ea4a244d5b39e0745aea1a89abff940e2c3922f))
* **api:** add /v1/responses and built-in tools ([91af47c](https://github.com/openai/openai-node/commit/91af47cc4f62b08a451bc39f44c64244a71c1f2c))
* **api:** add `get /chat/completions` endpoint ([9697139](https://github.com/openai/openai-node/commit/9697139a5f38bcc2dffa3322ff575eb1fc8b4e35))
* **api:** add `get /responses/{response_id}/input_items` endpoint ([f2c5aba](https://github.com/openai/openai-node/commit/f2c5aba736f99550a9a7837be22b39b36a7495d0))
* **api:** add container endpoint ([3ffca5c](https://github.com/openai/openai-node/commit/3ffca5c5b2dc6819e955ed343b2bb6e2095e7bdf))
* **api:** Add evalapi to sdk ([70092d7](https://github.com/openai/openai-node/commit/70092d768426b8e0dd4bca21e7a3dea009e25b9f))
* **api:** add gpt-4.5-preview ([1d4478d](https://github.com/openai/openai-node/commit/1d4478d7935028e20a9d9d11ff29ff8b991c44f9))
* **api:** add image sizes, reasoning encryption ([0c25021](https://github.com/openai/openai-node/commit/0c2502187f8895f029277a7be9825862f458e9aa))
* **api:** add o3 and o4-mini model IDs ([19cda5d](https://github.com/openai/openai-node/commit/19cda5d3b908238ae6c6f5609ac3a118d4d8acc2))
* **api:** Add reinforcement fine-tuning api support ([e6bbaf5](https://github.com/openai/openai-node/commit/e6bbaf577aa6bdf3bcdaf25a5a7d4e8202831c7a))
* **api:** add support for storing chat completions ([59da177](https://github.com/openai/openai-node/commit/59da1771b93158d5d89efc9e63e1ef9c09a634f3))
* **api:** adding gpt-4.1 family of model IDs ([8a2a745](https://github.com/openai/openai-node/commit/8a2a7454bee0fbe9e4729d47f6b894e5f25d68f5))
* **api:** adding new image model support ([a0010fd](https://github.com/openai/openai-node/commit/a0010fdb60fe723ebc70103cceca552aca51855e))
* **api:** Config update for pakrym-stream-param ([469ad7b](https://github.com/openai/openai-node/commit/469ad7b9d76b674aa3fd829128a54758ab7adfbd))
* **api:** further updates for evals API ([3f6f248](https://github.com/openai/openai-node/commit/3f6f248191b45015924be76fd5154d149c4ed8a0))
* **api:** manual updates ([debe529](https://github.com/openai/openai-node/commit/debe5295d077f79cc4b4eefefb008e5a10b32793))
* **api:** manual updates ([e83286b](https://github.com/openai/openai-node/commit/e83286b10b20d3e4c02903739b045af5cbf71cde))
* **api:** manual updates ([959eace](https://github.com/openai/openai-node/commit/959eace6ec132a83f731fa496d5b8b7a11fa6bb2))
* **api:** manual updates ([179a607](https://github.com/openai/openai-node/commit/179a607a89fabda32ebad62cc7ee86b5332a29f4))
* **api:** manual updates ([0cb0c86](https://github.com/openai/openai-node/commit/0cb0c863b3bda6e6d72b3b5cdba3c8791db9bb77))
* **api:** manual updates ([678ae6b](https://github.com/openai/openai-node/commit/678ae6b7112ed9b27d092b3234dd034d572deb9c))
* **api:** manual updates ([4560dc6](https://github.com/openai/openai-node/commit/4560dc62f8c65e9857085409e382760aa601d60b))
* **api:** manual updates ([554c3b1](https://github.com/openai/openai-node/commit/554c3b142024bec8010474cd7e42b99a209d4daa))
* **api:** manual updates ([b893d81](https://github.com/openai/openai-node/commit/b893d81420359c712dab6997c2dbc9f309549712))
* **api:** manual updates ([c1c2819](https://github.com/openai/openai-node/commit/c1c281983e23dcfdca964720265d3cba28b17795))
* **api:** manual updates ([efce6d3](https://github.com/openai/openai-node/commit/efce6d3d719ad463b035b22e9a1cf461ab62b5af))
* **api:** manual updates ([32afb00](https://github.com/openai/openai-node/commit/32afb0022939b19069c37fcd9cabfe666ea86b77))
* **api:** new API tools ([fb4014f](https://github.com/openai/openai-node/commit/fb4014ffac7b220d37bd03c94fa745386b010bf0))
* **api:** new models for TTS, STT, + new audio features for Realtime ([#1407](https://github.com/openai/openai-node/issues/1407)) ([d11b13c](https://github.com/openai/openai-node/commit/d11b13cdf5412f03e551365297a27e610a36edda))
* **api:** new streaming helpers for background responses ([1ddd6ff](https://github.com/openai/openai-node/commit/1ddd6ff182b09d696954fda4bde50fb82f1d6585))
* **api:** o1-pro now available through the API ([#1398](https://github.com/openai/openai-node/issues/1398)) ([aefd267](https://github.com/openai/openai-node/commit/aefd2675154ff848032a7fec856f0db6ed2ad629))
* **api:** responses x eval api ([ea1d56c](https://github.com/openai/openai-node/commit/ea1d56c979ad7136aa584a773904b0570ba14783))
* **api:** Updating Assistants and Evals API schemas ([8cc63d3](https://github.com/openai/openai-node/commit/8cc63d351057678d474fe1a16e3077370c83fddb))
* **client:** accept RFC6838 JSON content types ([67da9ce](https://github.com/openai/openai-node/commit/67da9ce89ea010813779b98c18fea84d9964c7de))
* **client:** add Realtime API support ([7737d25](https://github.com/openai/openai-node/commit/7737d2547c5c6c45004fe281b8122c9e2adc0efb))
* **client:** add withOptions helper ([7e9ea85](https://github.com/openai/openai-node/commit/7e9ea85f63a0989b3446834d9e1a94c0d050cf87))
* **client:** improve logging ([ead0ba4](https://github.com/openai/openai-node/commit/ead0ba4dc9f51c35007c5fe20f9954855f558652))
* **client:** promote beta completions methods to GA ([4c622f9](https://github.com/openai/openai-node/commit/4c622f9f55529e3aab30c834349d341038499db1))


### Bug Fixes

* **api:** add missing file rank enum + more metadata ([b943a0a](https://github.com/openai/openai-node/commit/b943a0ae4682a410172e1063a9424f5150cd9010))
* **api:** correct some Responses types ([#1391](https://github.com/openai/openai-node/issues/1391)) ([e983d0c](https://github.com/openai/openai-node/commit/e983d0c61d33b106f149d87eed90378bd0bbc349))
* **api:** improve type resolution when importing as a package ([#1444](https://github.com/openai/openai-node/issues/1444)) ([4af79dd](https://github.com/openai/openai-node/commit/4af79ddd5b19925fa09d9ae877470aa8304535c2))
* **assistants:** handle `thread.run.incomplete` event ([a2714bb](https://github.com/openai/openai-node/commit/a2714bb5253ade80cb15455ceb8f6dbea63cb1d0))
* **audio:** correctly handle transcription streaming ([9c7d352](https://github.com/openai/openai-node/commit/9c7d352181c690156e26c9538c00edff6db5b384))
* avoid type error in certain environments ([#1413](https://github.com/openai/openai-node/issues/1413)) ([f395e95](https://github.com/openai/openai-node/commit/f395e9584ac63780442bb54c2d292914eaecf3c7))
* **azure/audio:** use model param for deployments ([0eda70a](https://github.com/openai/openai-node/commit/0eda70adc3c88c12792c1eee9c3279579a86d412))
* **azure:** add /images/edits to deployments endpoints ([#1509](https://github.com/openai/openai-node/issues/1509)) ([4b18059](https://github.com/openai/openai-node/commit/4b180597633a527c435e049d885103ab06311b90))
* **azure:** add /images/edits to deployments endpoints ([#1509](https://github.com/openai/openai-node/issues/1509)) ([84fc31a](https://github.com/openai/openai-node/commit/84fc31aa903eceeb80815f6b17562fc463a71cfc))
* **azure:** use correct internal method ([a9c7821](https://github.com/openai/openai-node/commit/a9c78216d88379bc1d5103b30970f041d22083b8))
* **client:** always overwrite when merging headers ([c160550](https://github.com/openai/openai-node/commit/c160550761eed22b038ac8a5b477729fe298834c))
* **client:** fix export map for index exports ([#1328](https://github.com/openai/openai-node/issues/1328)) ([26d5868](https://github.com/openai/openai-node/commit/26d5868dd53045bc820a607100eab1070785f50c))
* **client:** fix export map for index exports, accept BunFile ([9416c96](https://github.com/openai/openai-node/commit/9416c96fdc12c9ea22da04ac317d93cb2ad94f57))
* **client:** fix TypeError with undefined File ([0e980d0](https://github.com/openai/openai-node/commit/0e980d05e8e1fb4befae443fb84b8b9fab8dbd50))
* **client:** remove duplicate types ([bee2ce5](https://github.com/openai/openai-node/commit/bee2ce5841f25b1f56cdc1fd0b36b0758d2c9bdc))
* **client:** remove duplicate types ([#1410](https://github.com/openai/openai-node/issues/1410)) ([23fd3ff](https://github.com/openai/openai-node/commit/23fd3ffef3b19656b27576b4d0c613d19ea1ae2f))
* **client:** return binary content from `get /containers/{container_id}/files/{file_id}/content` ([8502966](https://github.com/openai/openai-node/commit/8502966ed2fee9162ad14fdf04c893e1fa130a51))
* **client:** return binary content from `get /containers/{container_id}/files/{file_id}/content` ([899869b](https://github.com/openai/openai-node/commit/899869b40ab5f64145c48521378f1925f6b5b33a))
* **client:** return binary content from `get /containers/{container_id}/files/{file_id}/content` ([83129d7](https://github.com/openai/openai-node/commit/83129d7eac3dd784bb1c29fa344c5b808a59db73))
* **client:** send `X-Stainless-Timeout` in seconds ([5a272a7](https://github.com/openai/openai-node/commit/5a272a76515b09810fcb5d0ca63dd6050d1a8023))
* **client:** send `X-Stainless-Timeout` in seconds ([#1442](https://github.com/openai/openai-node/issues/1442)) ([5e5e460](https://github.com/openai/openai-node/commit/5e5e4607a103fcb6257c071bb4bf57902ee6415f))
* **client:** send all configured auth headers ([ee01414](https://github.com/openai/openai-node/commit/ee01414c206f18a537f3616bcf1e208aab311030))
* compat with more runtimes ([f743730](https://github.com/openai/openai-node/commit/f74373020ab01ace999a72d916e017db0177bf16))
* correct imports ([21f2107](https://github.com/openai/openai-node/commit/21f210782b1ee3b33231cfed0277ab8e3a764bcb))
* correctly decode multi-byte characters over multiple chunks ([f3d7083](https://github.com/openai/openai-node/commit/f3d708390a36427206edfc67875a7987eb483e55))
* **docs:** correct docstring on responses.stream ([1847673](https://github.com/openai/openai-node/commit/1847673de09586c809e1057a6b08c604471e13ff))
* **ecosystem-tests/bun:** bump dependencies ([1e52734](https://github.com/openai/openai-node/commit/1e52734e28a0e474b11c90977fd3161ea2e50f8c))
* **ecosystem-tests/cloudflare-worker:** ignore lib errors for now ([157248a](https://github.com/openai/openai-node/commit/157248ae85d2261f9538128703d0ebbc24347c61))
* **ecosystem-tests:** correct ecosystem tests setup ([6fa0675](https://github.com/openai/openai-node/commit/6fa06756624071fb1486c69a496ba906fef96de2))
* **embeddings:** correctly decode base64 data ([#1448](https://github.com/openai/openai-node/issues/1448)) ([d6b99c8](https://github.com/openai/openai-node/commit/d6b99c8fcbd35ef6b45d66f487aea759c01febbc))
* **exports:** add missing type exports ([a816029](https://github.com/openai/openai-node/commit/a81602996a1d9c3ceda79d88fe163a1e6b823e77))
* **exports:** add missing type exports ([#1417](https://github.com/openai/openai-node/issues/1417)) ([06c03d7](https://github.com/openai/openai-node/commit/06c03d7125d8331679dd206d0e34705d65669046))
* **exports:** ensure resource imports don't require /index ([d028ad7](https://github.com/openai/openai-node/commit/d028ad7b0debb585534acb73fa5cafe6f8d90f37))
* **helpers/zod:** error on optional + not nullable fields ([6e424b5](https://github.com/openai/openai-node/commit/6e424b5cac1b2ea7e108ce24154be5bdddf56bdd))
* **internal:** add mts file + crypto shim types ([a06deb8](https://github.com/openai/openai-node/commit/a06deb8aec21ecf8bfbc369112da10a790039178))
* **internal:** clean up undefined File test ([da43aa9](https://github.com/openai/openai-node/commit/da43aa91586fe80137c6500e850dca82085936b8))
* **internal:** fix file uploads in node 18 jest ([abfff03](https://github.com/openai/openai-node/commit/abfff03f49e62e195d112229127be674cc44497d))
* **internal:** work around https://github.com/vercel/next.js/issues/76881 ([#1427](https://github.com/openai/openai-node/issues/1427)) ([84edc62](https://github.com/openai/openai-node/commit/84edc62d05eddaefee0973f9687fcfdd43b0afa9))
* **jsr:** correct zod config ([04e30c0](https://github.com/openai/openai-node/commit/04e30c03ce0496a718aebf4cc2daac82ebba1ddb))
* **jsr:** export realtime helpers ([0ea64eb](https://github.com/openai/openai-node/commit/0ea64eb2bde99e243761ea2e3d9d3c294c9f7fbc))
* **jsr:** export zod helpers ([77e1180](https://github.com/openai/openai-node/commit/77e118082334710cab361efb95934422e4db6b18))
* **mcp:** remove unused tools.ts ([#1445](https://github.com/openai/openai-node/issues/1445)) ([4ba9947](https://github.com/openai/openai-node/commit/4ba994773b41a3ed05a3ad908b235fc5f3810dfc))
* optimize sse chunk reading off-by-one error ([#1339](https://github.com/openai/openai-node/issues/1339)) ([b0b4189](https://github.com/openai/openai-node/commit/b0b4189420e1c5bb5fc4bbb8925f88fe65f9b217))
* **package:** add chat/completions.ts back in ([#1333](https://github.com/openai/openai-node/issues/1333)) ([1f38cc1](https://github.com/openai/openai-node/commit/1f38cc1976f4091a90a38d49e6ddc1c22e5c39ab))
* **parsing:** remove tool_calls default empty array ([#1341](https://github.com/openai/openai-node/issues/1341)) ([6d056bf](https://github.com/openai/openai-node/commit/6d056bf95c9be4046decf20ec4c98dfa2bea2723))
* **realtime:** call .toString() on WebSocket url ([#1324](https://github.com/openai/openai-node/issues/1324)) ([6e9444c](https://github.com/openai/openai-node/commit/6e9444c6c77a93ff4ce06bd5b27a9c236ba6f307))
* **responses:** correct computer use enum value ([66fb815](https://github.com/openai/openai-node/commit/66fb8157217de604d7f535e917b085fa8b6754d4))
* **responses:** correct reasoning output type ([9cb9576](https://github.com/openai/openai-node/commit/9cb95763cab5678c5098b37ad0fe1ec83d2c1cb7))
* **responses:** correctly add output_text ([8ae07cc](https://github.com/openai/openai-node/commit/8ae07cc036895529a028134451fe2ab5c1661871))
* **responses:** support streaming retrieve calls ([657807c](https://github.com/openai/openai-node/commit/657807c2d7cbf2c6fc9a92ce98bb7295bb156326))
* **tests/embeddings:** avoid cross-realm issue ([aceaac0](https://github.com/openai/openai-node/commit/aceaac05c05fa318c4bff7ff340b512a6bd904b9))
* **tests:** don't rely on OPENAI_API_KEY env variable ([087580a](https://github.com/openai/openai-node/commit/087580ae5ebedc88f6f219c7d00c08607722a519))
* **tests:** manually reset node:buffer File ([1d18ed4](https://github.com/openai/openai-node/commit/1d18ed4f90436e7041835d201c8cb1c373ded418))
* **tests:** port tests to new setup ([9eb9854](https://github.com/openai/openai-node/commit/9eb98543660c86f0b11766ef95b35fa28fd16e47))
* **tests:** stop using node:stream ([317a04d](https://github.com/openai/openai-node/commit/317a04d8d189ee33a9dd5308668296a708b391a8))
* **threads:** remove unused duplicative types ([0b77c7c](https://github.com/openai/openai-node/commit/0b77c7c9da64962fd50854be06661cdce549d326))
* **types:** export AssistantStream ([#1472](https://github.com/openai/openai-node/issues/1472)) ([bc492ba](https://github.com/openai/openai-node/commit/bc492ba124cddd545eec7a1199712452c573a7a4))
* **types:** export ParseableToolsParams ([#1486](https://github.com/openai/openai-node/issues/1486)) ([3e7c92c](https://github.com/openai/openai-node/commit/3e7c92c8a76c1f747610d63d9d69a88b796ee9fc))
* **types:** ignore missing `id` in responses pagination ([d2be74a](https://github.com/openai/openai-node/commit/d2be74a28dec48cd7d88db88af95e8bc608cdede))
* **types:** improve responses type names ([#1392](https://github.com/openai/openai-node/issues/1392)) ([4548326](https://github.com/openai/openai-node/commit/454832606ebe9d5cf8ffd436eac09375f682c495))
* **zod:** warn on optional field usage ([#1469](https://github.com/openai/openai-node/issues/1469)) ([aea2d12](https://github.com/openai/openai-node/commit/aea2d123d200e6a7eae11e66583127270a8db8bf))


### Performance Improvements

* **embedding:** default embedding creation to base64 ([#1312](https://github.com/openai/openai-node/issues/1312)) ([be00d29](https://github.com/openai/openai-node/commit/be00d29fadb2b78920bcae1e6e72750bc6f973a4)), closes [#1310](https://github.com/openai/openai-node/issues/1310)


### Chores

* add hash of OpenAPI spec/config inputs to .stats.yml ([1b0a94d](https://github.com/openai/openai-node/commit/1b0a94d088c2891fcad0ca0de3a1e4e205a7c9cf))
* add missing type alias exports ([5d75cb9](https://github.com/openai/openai-node/commit/5d75cb95019ae77eafb0c878b355f09a1f87c3bd))
* **api:** updates to supported Voice IDs ([28130c7](https://github.com/openai/openai-node/commit/28130c7fe172dd90fcf2036dc72750e485e42645))
* **ci:** add timeout thresholds for CI jobs ([5775451](https://github.com/openai/openai-node/commit/5775451a55212687ba998b332c1394528d98121f))
* **ci:** bump node version for release workflows ([bbf5d45](https://github.com/openai/openai-node/commit/bbf5d45259a8bfba62e2217955597ec0f6cfead4))
* **ci:** only use depot for staging repos ([c59c3b5](https://github.com/openai/openai-node/commit/c59c3b5ead95b424b27c8c9f2120ad4283fb280e))
* **ci:** run on more branches and use depot runners ([e17a4f8](https://github.com/openai/openai-node/commit/e17a4f8e1fc3de02c953421debf39827ea72d52c))
* **client:** drop support for EOL node versions ([a326944](https://github.com/openai/openai-node/commit/a326944e8a8822bc70f86d7046de3142f9dff530))
* **client:** expose headers on some streaming errors ([#1423](https://github.com/openai/openai-node/issues/1423)) ([6c93a23](https://github.com/openai/openai-node/commit/6c93a23b79f335a21c65b52d1192890a5325ed6d))
* **client:** minor internal fixes ([5032c28](https://github.com/openai/openai-node/commit/5032c2802bd51885270badf47e27768f62240d25))
* **client:** more accurate streaming errors ([0c21914](https://github.com/openai/openai-node/commit/0c21914d90b0ef1073d99c539cf9ef18912b8d0b))
* **client:** move misc public files to new `core/` directory, deprecate old paths ([38c9d54](https://github.com/openai/openai-node/commit/38c9d548fded9000cde85270b38085c61905b5c1))
* **client:** only accept standard types for file uploads ([53e35c8](https://github.com/openai/openai-node/commit/53e35c8b10a8e3ef95c0d644d59ab915225b8114))
* deprecate Assistants API ([0be23b9](https://github.com/openai/openai-node/commit/0be23b98b6be9f8922d035270b1c907307010a29))
* **docs:** add missing deprecation warnings ([995075b](https://github.com/openai/openai-node/commit/995075b632051b5bb33c0381056107b2fe93931e))
* **docs:** grammar improvements ([7761cfb](https://github.com/openai/openai-node/commit/7761cfb0a8a56d056a73c046a6a613f66ada4abe))
* **docs:** improve docs for withResponse/asResponse ([9f4c30b](https://github.com/openai/openai-node/commit/9f4c30b9bcc2f373b3087dba69bd837f96f79d81))
* **docs:** improve migration doc ([732d870](https://github.com/openai/openai-node/commit/732d87001cbd9aa095e7b58dc843e86547e3f510))
* **docs:** update zod tool call example, fix azure tests ([f18ced8](https://github.com/openai/openai-node/commit/f18ced883e4b5d689e0569d9b163b1958688b669))
* **exports:** cleaner resource index imports ([#1396](https://github.com/openai/openai-node/issues/1396)) ([023d106](https://github.com/openai/openai-node/commit/023d106185abf62f892bff66faf617eb45777004))
* **exports:** stop using path fallbacks ([09af7ff](https://github.com/openai/openai-node/commit/09af7ffd42458c6c26d9325060fcb8925aca7c81))
* **exports:** stop using path fallbacks ([#1397](https://github.com/openai/openai-node/issues/1397)) ([7c3d212](https://github.com/openai/openai-node/commit/7c3d212b47ee3090f5bbb82dd21026ba532da6e0))
* fix example types ([20f179d](https://github.com/openai/openai-node/commit/20f179db1bb681db5d1a91adcaab16012d6ffcdf))
* improve publish-npm script --latest tag logic ([6207a2a](https://github.com/openai/openai-node/commit/6207a2a03d3279423de594eed18c5efb4ce321af))
* **internal:** add aliases for Record and Array ([#1443](https://github.com/openai/openai-node/issues/1443)) ([1cb66b6](https://github.com/openai/openai-node/commit/1cb66b6ccbcecaa6e48b90d37d8cac4840bb69a4))
* **internal:** add back release workflow ([ca6266e](https://github.com/openai/openai-node/commit/ca6266eea5229056a3bc2b5e4225b9ea9eaa459e))
* **internal:** add Bun.File ecosystem test ([cb4194f](https://github.com/openai/openai-node/commit/cb4194f08a2dcb4fc4231bf1b74ed5d6e0aca435))
* **internal:** add missing return type annotation ([#1334](https://github.com/openai/openai-node/issues/1334)) ([13aab10](https://github.com/openai/openai-node/commit/13aab101588c2eee1250d7c50b2abfeca1c5fa3d))
* **internal:** add proxy ecosystem tests ([619711a](https://github.com/openai/openai-node/commit/619711ae0da5243c64c266d615703279f7651f58))
* **internal:** bump migration cli version ([a899c97](https://github.com/openai/openai-node/commit/a899c9748de17ef468a03a97b9ed82124189ff4c))
* **internal:** codegen related update ([c735a3c](https://github.com/openai/openai-node/commit/c735a3c24ac8255df50f89c519fb7dfc617db045))
* **internal:** fix devcontainers setup ([#1343](https://github.com/openai/openai-node/issues/1343)) ([9485f5d](https://github.com/openai/openai-node/commit/9485f5d4d6718bff7f579223c9aa528898451533))
* **internal:** fix eslint ignores ([ad5a9b6](https://github.com/openai/openai-node/commit/ad5a9b6f07002df70764f1b9e5d6cd675eba87ea))
* **internal:** fix examples ([#1457](https://github.com/openai/openai-node/issues/1457)) ([a100f0a](https://github.com/openai/openai-node/commit/a100f0a0e1d336f8a78c8bbd9e3703cda3f0c5d8))
* **internal:** fix format script ([3e1ea40](https://github.com/openai/openai-node/commit/3e1ea4063327ac34f4f46536600a8923f96dbbb0))
* **internal:** fix formatting ([6469d53](https://github.com/openai/openai-node/commit/6469d5323b653f19e90a7470d81c914c640c6f8b))
* **internal:** fix lint ([45a372c](https://github.com/openai/openai-node/commit/45a372ca0436f2f79c2387665b1c1bc04fd3bfed))
* **internal:** fix release workflows ([353349d](https://github.com/openai/openai-node/commit/353349de9ee10d32d3243cb5c60a8ae982c49d37))
* **internal:** fix tests failing on node v18 ([c54270a](https://github.com/openai/openai-node/commit/c54270a58ada1d0d7878ce80c7c2093a56fed158))
* **internal:** fix tests not always being type checked ([0266b41](https://github.com/openai/openai-node/commit/0266b41efa311205f0fc51b6dc6d29ab003254a6))
* **internal:** improve node 18 shims ([ee3f483](https://github.com/openai/openai-node/commit/ee3f48333a1d73a096f3417b2701fd722e4fbc68))
* **internal:** minor client file refactoring ([d1aa00a](https://github.com/openai/openai-node/commit/d1aa00afc760f73624a8a109600c03deba40e72b))
* **internal:** only run examples workflow in main repo ([#1450](https://github.com/openai/openai-node/issues/1450)) ([93569f3](https://github.com/openai/openai-node/commit/93569f39799512604db439af20f0ef0ad3dae295))
* **internal:** reduce CI branch coverage ([77fc77f](https://github.com/openai/openai-node/commit/77fc77f7d05d03eafe6c8f002044c60c4bab3c64))
* **internal:** refactor utils ([e7fbfbc](https://github.com/openai/openai-node/commit/e7fbfbce41c00aaa7d3b75a4bf001c7562b5b722))
* **internal:** remove CI condition ([#1381](https://github.com/openai/openai-node/issues/1381)) ([e905c95](https://github.com/openai/openai-node/commit/e905c95a27213ee65210b061ead4c982de01648b))
* **internal:** remove unnecessary todo ([b55321e](https://github.com/openai/openai-node/commit/b55321e2d0713d41b4050e8ccf0ac4eefb45be3a))
* **internal:** run CI on update-specs branch ([9c45ef3](https://github.com/openai/openai-node/commit/9c45ef37249e7db3ba8aa2e81886ffe306b95da4))
* **internal:** run example files in CI ([#1357](https://github.com/openai/openai-node/issues/1357)) ([1044c48](https://github.com/openai/openai-node/commit/1044c487566569e773d5f6c1a94ce6b614e62b80))
* **internal:** share typescript helpers ([2470933](https://github.com/openai/openai-node/commit/247093374538f0e714178134c38813bc4fde9ecf))
* **internal:** skip broken test ([#1458](https://github.com/openai/openai-node/issues/1458)) ([58f4559](https://github.com/openai/openai-node/commit/58f4559d952f6e56a8f27a6bcaba0acf295623df))
* **internal:** update @types/bun ([d94b41a](https://github.com/openai/openai-node/commit/d94b41a58e24c82c3f7369bd1360b394e93cf1dd))
* **internal:** update release workflows ([2cbf49a](https://github.com/openai/openai-node/commit/2cbf49a0b9a8cfbee29cec558c5ccdcebd72396f))
* **internal:** upload builds and expand CI branch coverage ([#1460](https://github.com/openai/openai-node/issues/1460)) ([2d45287](https://github.com/openai/openai-node/commit/2d452879000c07f3ef4e775e19a527f5f6fa7b4c))
* **migration:** add beta handling ([3508099](https://github.com/openai/openai-node/commit/3508099991ecfa260d77678037275133130e09dc))
* move ChatModel type to shared ([236dbf4](https://github.com/openai/openai-node/commit/236dbf4092fccf7697852c6341a8f38f0241770c))
* **package:** remove engines ([500a82f](https://github.com/openai/openai-node/commit/500a82f45d46697be14987e12d896acb2b109d32))
* **perf:** faster base64 decoding ([11b9534](https://github.com/openai/openai-node/commit/11b9534d317f87cdcb1934ead013f058865e675e))
* **tests:** improve enum examples ([#1454](https://github.com/openai/openai-node/issues/1454)) ([15a86c9](https://github.com/openai/openai-node/commit/15a86c958bf300486907f2498e1028fc9bc50b00))
* **tests:** stop using node-fetch, don't directly upload FormDataFile ([ebd464f](https://github.com/openai/openai-node/commit/ebd464f5ad07f440ad476c0a7ce733947da414e2))
* **tests:** switch proxy tests to fetchOptions ([da6ed5f](https://github.com/openai/openai-node/commit/da6ed5fc4c9ec203d9add28c34c90532b0334a3e))
* **types:** improved go to definition on fetchOptions ([f1712cd](https://github.com/openai/openai-node/commit/f1712cdea42e9d95d4b2dc40aae5cebc8e14c76d))
* update next to 14.2.25 for CVE-2025-29927 ([1ed4288](https://github.com/openai/openai-node/commit/1ed4288c7b9ca8fcb00e524bc6f39c255c6661c5))
* workaround build errors ([e4a7f67](https://github.com/openai/openai-node/commit/e4a7f674f719a87bb78378a5ce4639d84620e17a))
* workaround build errors ([d6b396b](https://github.com/openai/openai-node/commit/d6b396b94d9ccf64ddfe945069012b6162225fa9))


### Documentation

* add examples to tsdocs ([e8d2092](https://github.com/openai/openai-node/commit/e8d2092e51015b05fe7ef33ef5a9d7652846b137))
* fix "procesing" -&gt; "processing" in realtime examples ([#1406](https://github.com/openai/openai-node/issues/1406)) ([dfbdc65](https://github.com/openai/openai-node/commit/dfbdc65d3ed17f0063d02906239371b88e04e5fd))
* **migration:** mention zod helpers error ([43b870d](https://github.com/openai/openai-node/commit/43b870d1651d0c13e4ec10a53de2dfbae276c3e7))
* **readme:** fix typo ([c44ed98](https://github.com/openai/openai-node/commit/c44ed98a3e7f497a656d612037667dd1f2e6816b))
* **readme:** fix typo ([0989ddc](https://github.com/openai/openai-node/commit/0989ddcfd5ed0a149bbc67d61f93e0f49c397c72))
* update URLs from stainlessapi.com to stainless.com ([#1352](https://github.com/openai/openai-node/issues/1352)) ([634a209](https://github.com/openai/openai-node/commit/634a209a6025640e2849133f6997af8faa28d4d8))


### Refactors

* **client:** remove deprecated runFunctions method ([e29a009](https://github.com/openai/openai-node/commit/e29a0092e9b077c2a99cd521a316aea4c25ea632))
* **functions:** rename function helper methods to include tools ([fdd6f66](https://github.com/openai/openai-node/commit/fdd6f6672ec577cbb6876fe3857a2161402513c3))

## 4.104.0 (2025-05-29)

Full Changelog: [v4.103.0...v4.104.0](https://github.com/openai/openai-node/compare/v4.103.0...v4.104.0)

### Features

* **api:** Config update for pakrym-stream-param ([469ad7b](https://github.com/openai/openai-node/commit/469ad7b9d76b674aa3fd829128a54758ab7adfbd))


### Bug Fixes

* **azure:** add /images/edits to deployments endpoints ([#1509](https://github.com/openai/openai-node/issues/1509)) ([84fc31a](https://github.com/openai/openai-node/commit/84fc31aa903eceeb80815f6b17562fc463a71cfc))
* **client:** return binary content from `get /containers/{container_id}/files/{file_id}/content` ([83129d7](https://github.com/openai/openai-node/commit/83129d7eac3dd784bb1c29fa344c5b808a59db73))


### Chores

* deprecate Assistants API ([5b34fcd](https://github.com/openai/openai-node/commit/5b34fcdd1454b8cccbaaf05ace6516afb3b09273))
* improve publish-npm script --latest tag logic ([6207a2a](https://github.com/openai/openai-node/commit/6207a2a03d3279423de594eed18c5efb4ce321af))
* **internal:** fix release workflows ([353349d](https://github.com/openai/openai-node/commit/353349de9ee10d32d3243cb5c60a8ae982c49d37))

## 4.103.0 (2025-05-22)

Full Changelog: [v4.102.0...v4.103.0](https://github.com/openai/openai-node/compare/v4.102.0...v4.103.0)

### Features

* **api:** new streaming helpers for background responses ([1ddd6ff](https://github.com/openai/openai-node/commit/1ddd6ff182b09d696954fda4bde50fb82f1d6585))

## 4.102.0 (2025-05-21)

Full Changelog: [v4.101.0...v4.102.0](https://github.com/openai/openai-node/compare/v4.101.0...v4.102.0)

### Features

* **api:** add container endpoint ([e973476](https://github.com/openai/openai-node/commit/e9734764625275c50ef612ff934804be8cb2adff))

## 4.101.0 (2025-05-21)

Full Changelog: [v4.100.0...v4.101.0](https://github.com/openai/openai-node/compare/v4.100.0...v4.101.0)

### Features

* **api:** new API tools ([fb4014f](https://github.com/openai/openai-node/commit/fb4014ffac7b220d37bd03c94fa745386b010bf0))


### Chores

* **docs:** grammar improvements ([7761cfb](https://github.com/openai/openai-node/commit/7761cfb0a8a56d056a73c046a6a613f66ada4abe))
* **internal:** version bump ([b40e830](https://github.com/openai/openai-node/commit/b40e8302ec11683b6a360a050236ad1284afc760))

## 4.100.0 (2025-05-16)

Full Changelog: [v4.99.0...v4.100.0](https://github.com/openai/openai-node/compare/v4.99.0...v4.100.0)

### Features

* **api:** further updates for evals API ([3f6f248](https://github.com/openai/openai-node/commit/3f6f248191b45015924be76fd5154d149c4ed8a0))


### Chores

* **internal:** version bump ([5123fe0](https://github.com/openai/openai-node/commit/5123fe08a56f3d0040b1cc67129382f3eacc3cca))

## 4.99.0 (2025-05-16)

Full Changelog: [v4.98.0...v4.99.0](https://github.com/openai/openai-node/compare/v4.98.0...v4.99.0)

### Features

* **api:** manual updates ([75eb804](https://github.com/openai/openai-node/commit/75eb804edd6ad653eaa22d47f8c6d09ee845ebf4))
* **api:** responses x eval api ([5029f1a](https://github.com/openai/openai-node/commit/5029f1a05eb1e8601ada06e0a5ba49f4c2b83c02))
* **api:** Updating Assistants and Evals API schemas ([27fd517](https://github.com/openai/openai-node/commit/27fd5173b20f75debe96024ae8f1ce58a8254d26))

## 4.98.0 (2025-05-08)

Full Changelog: [v4.97.0...v4.98.0](https://github.com/openai/openai-node/compare/v4.97.0...v4.98.0)

### Features

* **api:** Add reinforcement fine-tuning api support ([4aa7a79](https://github.com/openai/openai-node/commit/4aa7a7954c63caa26cc1640ace56093fe1cafa04))


### Chores

* **ci:** bump node version for release workflows ([2961f63](https://github.com/openai/openai-node/commit/2961f63c4d5b8ae8efdf8ea6581aa83c6b0f722e))
* **internal:** fix formatting ([91a44fe](https://github.com/openai/openai-node/commit/91a44fe11c0847dc50d48a03a8d409ac4bece37a))


### Documentation

* add examples to tsdocs ([7d841b7](https://github.com/openai/openai-node/commit/7d841b7f98eb542a398fb9de12056125e8d6cb22))

## 4.97.0 (2025-05-02)

Full Changelog: [v4.96.2...v4.97.0](https://github.com/openai/openai-node/compare/v4.96.2...v4.97.0)

### Features

* **api:** add image sizes, reasoning encryption ([9c2113a](https://github.com/openai/openai-node/commit/9c2113af7c7ea9a797a0e39d07d9ad8627c96acb))


### Chores

* **docs:** add missing deprecation warnings ([253392c](https://github.com/openai/openai-node/commit/253392c93adca88e0ee83f784183b2128ff64a16))


### Documentation

* fix "procesing" -&gt; "processing" in realtime examples ([#1406](https://github.com/openai/openai-node/issues/1406)) ([8717b9f](https://github.com/openai/openai-node/commit/8717b9fce87d03e51d40ee58f5d6259408405e1f))
* **readme:** fix typo ([cab3478](https://github.com/openai/openai-node/commit/cab3478f195f9de5c21033a1b3684f52ad347ffc))

## 4.96.2 (2025-04-29)

Full Changelog: [v4.96.1...v4.96.2](https://github.com/openai/openai-node/compare/v4.96.1...v4.96.2)

### Bug Fixes

* **types:** export ParseableToolsParams ([#1486](https://github.com/openai/openai-node/issues/1486)) ([3e7c92c](https://github.com/openai/openai-node/commit/3e7c92c8a76c1f747610d63d9d69a88b796ee9fc))


### Chores

* **ci:** only use depot for staging repos ([214da39](https://github.com/openai/openai-node/commit/214da398c76f46d40994665f3ca7e10e203e9579))
* **ci:** run on more branches and use depot runners ([ead76fc](https://github.com/openai/openai-node/commit/ead76fc6429ac52a1c8b008ac5c0afcefaa0bae5))

## 4.96.1 (2025-04-29)

Full Changelog: [v4.96.0...v4.96.1](https://github.com/openai/openai-node/compare/v4.96.0...v4.96.1)

### Bug Fixes

* **types:** export ParseableToolsParams ([#1486](https://github.com/openai/openai-node/issues/1486)) ([eb055b2](https://github.com/openai/openai-node/commit/eb055b26ce90e5fe1b101a95a4390956d519e168))


### Chores

* **ci:** only use depot for staging repos ([e80af47](https://github.com/openai/openai-node/commit/e80af47590056baa8f456e8d60c37f0d00ff08c4))
* **ci:** run on more branches and use depot runners ([b04a801](https://github.com/openai/openai-node/commit/b04a801d0356105eacddbb4d10f4359719585dd6))

## 4.96.0 (2025-04-23)

Full Changelog: [v4.95.1...v4.96.0](https://github.com/openai/openai-node/compare/v4.95.1...v4.96.0)

### Features

* **api:** adding new image model support ([a00d331](https://github.com/openai/openai-node/commit/a00d33190edd08df7d9c088c00ab7b77673f88ba))


### Bug Fixes

* **types:** export AssistantStream ([#1472](https://github.com/openai/openai-node/issues/1472)) ([626c844](https://github.com/openai/openai-node/commit/626c844a758a68ffbff48873d4773be2e3868952))


### Chores

* **ci:** add timeout thresholds for CI jobs ([e465063](https://github.com/openai/openai-node/commit/e46506351097f1de39c866c28b6ec20fa724fc36))

## 4.95.1 (2025-04-18)

Full Changelog: [v4.95.0...v4.95.1](https://github.com/openai/openai-node/compare/v4.95.0...v4.95.1)

### Bug Fixes

* **zod:** warn on optional field usage ([#1469](https://github.com/openai/openai-node/issues/1469)) ([aea2d12](https://github.com/openai/openai-node/commit/aea2d123d200e6a7eae11e66583127270a8db8bf))

## 4.95.0 (2025-04-16)

Full Changelog: [v4.94.0...v4.95.0](https://github.com/openai/openai-node/compare/v4.94.0...v4.95.0)

### Features

* **api:** add o3 and o4-mini model IDs ([4845cd9](https://github.com/openai/openai-node/commit/4845cd9ac17450022f1632ae01397e41a97f1662))

## 4.94.0 (2025-04-14)

Full Changelog: [v4.93.0...v4.94.0](https://github.com/openai/openai-node/compare/v4.93.0...v4.94.0)

### Features

* **api:** adding gpt-4.1 family of model IDs ([bddcbcf](https://github.com/openai/openai-node/commit/bddcbcffdc409ffc8a078a65bbd302cd50b35ff0))
* **api:** manual updates ([7532f48](https://github.com/openai/openai-node/commit/7532f48ad25c5125064a59985587c20c47a2cbfb))


### Chores

* **client:** minor internal fixes ([d342f17](https://github.com/openai/openai-node/commit/d342f17e2642da5ee83d080b410dc3c4fe153814))
* **internal:** reduce CI branch coverage ([a49b94a](https://github.com/openai/openai-node/commit/a49b94a9aebd3e30e1802fff633e1b46cfb81942))
* **internal:** upload builds and expand CI branch coverage ([#1460](https://github.com/openai/openai-node/issues/1460)) ([7e23bb4](https://github.com/openai/openai-node/commit/7e23bb4f4a09303195b612cc5b393cc41c1d855b))
* workaround build errors ([913eba8](https://github.com/openai/openai-node/commit/913eba828d116f49fa78b219c62274c1e95c6f17))

## 4.93.0 (2025-04-08)

Full Changelog: [v4.92.1...v4.93.0](https://github.com/openai/openai-node/compare/v4.92.1...v4.93.0)

### Features

* **api:** Add evalapi to sdk ([#1456](https://github.com/openai/openai-node/issues/1456)) ([ee917e3](https://github.com/openai/openai-node/commit/ee917e3335fcf44e87a28e54ce8ddfdcdfab1652))


### Chores

* **internal:** fix examples ([#1457](https://github.com/openai/openai-node/issues/1457)) ([a3dd0dd](https://github.com/openai/openai-node/commit/a3dd0dde3e8ad9cc7a02cf203d4550f91d31a2ae))
* **internal:** skip broken test ([#1458](https://github.com/openai/openai-node/issues/1458)) ([4d2f815](https://github.com/openai/openai-node/commit/4d2f815ba5f6c426f9c21f4c3db443166389bbf8))
* **tests:** improve enum examples ([#1454](https://github.com/openai/openai-node/issues/1454)) ([ecabce2](https://github.com/openai/openai-node/commit/ecabce282a9fb60122310942f3b647dfefae5403))

## 4.92.1 (2025-04-07)

Full Changelog: [v4.92.0...v4.92.1](https://github.com/openai/openai-node/compare/v4.92.0...v4.92.1)

### Chores

* **internal:** only run examples workflow in main repo ([#1450](https://github.com/openai/openai-node/issues/1450)) ([5e49a7a](https://github.com/openai/openai-node/commit/5e49a7a447bb788fa05898c15ae57c6ea9c8fd49))

## 4.92.0 (2025-04-07)

Full Changelog: [v4.91.1...v4.92.0](https://github.com/openai/openai-node/compare/v4.91.1...v4.92.0)

### Features

* **api:** manual updates ([891754d](https://github.com/openai/openai-node/commit/891754d7fa42d71ce4f93288dd043ef0b97fee23))
* **api:** manual updates ([01e5546](https://github.com/openai/openai-node/commit/01e5546f3f48a1f4d645e09e7581f16b30f25bdd))
* **api:** manual updates ([f38dbf3](https://github.com/openai/openai-node/commit/f38dbf3b39b0800b3bbef5c603a4fa2b616f25d8))
* **api:** manual updates ([1f12253](https://github.com/openai/openai-node/commit/1f12253054a5a7e35dc03b17901b4c1f33bf5b3d))


### Bug Fixes

* **api:** improve type resolution when importing as a package ([#1444](https://github.com/openai/openai-node/issues/1444)) ([4aa46d6](https://github.com/openai/openai-node/commit/4aa46d6c0da681bcdde31fcbb09e8ba6fdaf764b))
* **client:** send `X-Stainless-Timeout` in seconds ([#1442](https://github.com/openai/openai-node/issues/1442)) ([aa4206c](https://github.com/openai/openai-node/commit/aa4206c7d93b4e3114a697f5467ffbbf5a64d1a8))
* **embeddings:** correctly decode base64 data ([#1448](https://github.com/openai/openai-node/issues/1448)) ([58128f7](https://github.com/openai/openai-node/commit/58128f7efde73726da740c42adde7b02cdf60a6a))
* **mcp:** remove unused tools.ts ([#1445](https://github.com/openai/openai-node/issues/1445)) ([520a8fa](https://github.com/openai/openai-node/commit/520a8fa77a69ce5855dde3481f9bd39339cb7b83))


### Chores

* **internal:** add aliases for Record and Array ([#1443](https://github.com/openai/openai-node/issues/1443)) ([b65391b](https://github.com/openai/openai-node/commit/b65391ba10d5063035c3e5c0bcc5a48ffc80f41d))

## 4.91.1 (2025-04-01)

Full Changelog: [v4.91.0...v4.91.1](https://github.com/openai/openai-node/compare/v4.91.0...v4.91.1)

### Bug Fixes

* **docs:** correct docstring on responses.stream ([1c8cd6a](https://github.com/openai/openai-node/commit/1c8cd6a638128b0ff5fac89d6c7db256f0b63a85))


### Chores

* Remove deprecated/unused remote spec feature ([ce3dfa8](https://github.com/openai/openai-node/commit/ce3dfa88bd4d395debccc0e6e1aac6d218b07cb8))

## 4.91.0 (2025-03-31)

Full Changelog: [v4.90.0...v4.91.0](https://github.com/openai/openai-node/compare/v4.90.0...v4.91.0)

### Features

* **api:** add `get /responses/{response_id}/input_items` endpoint ([ef0e0ac](https://github.com/openai/openai-node/commit/ef0e0acd469379ae6f2745c83e6c6813ff7b4edc))


### Performance Improvements

* **embedding:** default embedding creation to base64 ([#1312](https://github.com/openai/openai-node/issues/1312)) ([e54530e](https://github.com/openai/openai-node/commit/e54530e4f6f00d7d74fc8636bbdb6f6280548750)), closes [#1310](https://github.com/openai/openai-node/issues/1310)

## 4.90.0 (2025-03-27)

Full Changelog: [v4.89.1...v4.90.0](https://github.com/openai/openai-node/compare/v4.89.1...v4.90.0)

### Features

* **api:** add `get /chat/completions` endpoint ([2d6710a](https://github.com/openai/openai-node/commit/2d6710a1f9dd4f768d9c73e9c9f5f93c737cdc66))


### Bug Fixes

* **audio:** correctly handle transcription streaming ([2a9b603](https://github.com/openai/openai-node/commit/2a9b60336cd40a4d4fb9b898ece49170ad648fd0))
* **internal:** work around https://github.com/vercel/next.js/issues/76881 ([#1427](https://github.com/openai/openai-node/issues/1427)) ([b467e94](https://github.com/openai/openai-node/commit/b467e949476621e8e92587a83c9de6fab35b2b9d))


### Chores

* add hash of OpenAPI spec/config inputs to .stats.yml ([45db35e](https://github.com/openai/openai-node/commit/45db35e34be560c75bf36224cc153c6d0e6e2a88))
* **api:** updates to supported Voice IDs ([#1424](https://github.com/openai/openai-node/issues/1424)) ([404f4db](https://github.com/openai/openai-node/commit/404f4db41a2ee651f5bfdaa7b8881e1bf015f058))
* **client:** expose headers on some streaming errors ([#1423](https://github.com/openai/openai-node/issues/1423)) ([b0783cc](https://github.com/openai/openai-node/commit/b0783cc6221b68f1738e759b393756a7d0e540a3))

## 4.89.1 (2025-03-26)

Full Changelog: [v4.89.0...v4.89.1](https://github.com/openai/openai-node/compare/v4.89.0...v4.89.1)

### Bug Fixes

* avoid type error in certain environments ([#1413](https://github.com/openai/openai-node/issues/1413)) ([d3f6f8f](https://github.com/openai/openai-node/commit/d3f6f8f9c7511a98cc5795756fee49a30e44d485))
* **client:** remove duplicate types ([#1410](https://github.com/openai/openai-node/issues/1410)) ([338878b](https://github.com/openai/openai-node/commit/338878bf484dac5a4fadf50592b1f8d1045cd4b6))
* **exports:** add missing type exports ([#1417](https://github.com/openai/openai-node/issues/1417)) ([2d15ada](https://github.com/openai/openai-node/commit/2d15ada0e0d81a4e0d097dddbe99be2222c4c0ef))


### Chores

* **internal:** version bump ([#1408](https://github.com/openai/openai-node/issues/1408)) ([9c0949a](https://github.com/openai/openai-node/commit/9c0949a93c3e181d327f820dbc2a4b0ad77258e9))

## 4.89.0 (2025-03-20)

Full Changelog: [v4.88.0...v4.89.0](https://github.com/openai/openai-node/compare/v4.88.0...v4.89.0)

### Features

* add audio helpers ([ea1b6b4](https://github.com/openai/openai-node/commit/ea1b6b4ef38813af568b3662037519da9404b80e))
* **api:** new models for TTS, STT, + new audio features for Realtime ([#1407](https://github.com/openai/openai-node/issues/1407)) ([142933a](https://github.com/openai/openai-node/commit/142933ae70d06045dbf4661cd72c7fa35ae7903d))


### Chores

* **internal:** version bump ([#1400](https://github.com/openai/openai-node/issues/1400)) ([6838ab4](https://github.com/openai/openai-node/commit/6838ab4268c7c0e083e7be21ef1a51bdea0f0b57))

## 4.88.0 (2025-03-19)

Full Changelog: [v4.87.4...v4.88.0](https://github.com/openai/openai-node/compare/v4.87.4...v4.88.0)

### Features

* **api:** o1-pro now available through the API ([#1398](https://github.com/openai/openai-node/issues/1398)) ([616a7e9](https://github.com/openai/openai-node/commit/616a7e90e764882cd749a65af8cc6ae8734fc80d))


### Chores

* **exports:** cleaner resource index imports ([#1396](https://github.com/openai/openai-node/issues/1396)) ([26b0856](https://github.com/openai/openai-node/commit/26b0856cd63846c34b75895a1ea42ceec7908c1a))
* **exports:** stop using path fallbacks ([#1397](https://github.com/openai/openai-node/issues/1397)) ([d1479c2](https://github.com/openai/openai-node/commit/d1479c23aff68dd46c73fd31896dd2298a6bf140))
* **internal:** version bump ([#1393](https://github.com/openai/openai-node/issues/1393)) ([7f16c3a](https://github.com/openai/openai-node/commit/7f16c3aa7b1ab36541219c5a0f93fc518733d0e3))

## 4.87.4 (2025-03-18)

Full Changelog: [v4.87.3...v4.87.4](https://github.com/openai/openai-node/compare/v4.87.3...v4.87.4)

### Bug Fixes

* **api:** correct some Responses types ([#1391](https://github.com/openai/openai-node/issues/1391)) ([af45876](https://github.com/openai/openai-node/commit/af458766ac721fb6cf18e7d78c458506c8bfc4e1))
* **types:** ignore missing `id` in responses pagination ([1b9d20e](https://github.com/openai/openai-node/commit/1b9d20e71f5afbd4999f1999fe4810175476c5d2))
* **types:** improve responses type names ([#1392](https://github.com/openai/openai-node/issues/1392)) ([164f476](https://github.com/openai/openai-node/commit/164f47606b41fd3e2850f8209eb1c6e2996a81ff))


### Chores

* add missing type alias exports ([#1390](https://github.com/openai/openai-node/issues/1390)) ([16c5e22](https://github.com/openai/openai-node/commit/16c5e2261c8c1a0ba96c2d5f475e8b1bc67387d7))
* **internal:** add back release workflow ([dddf29b](https://github.com/openai/openai-node/commit/dddf29bd914a02d4586b239ec06217389a4409f9))
* **internal:** remove CI condition ([#1381](https://github.com/openai/openai-node/issues/1381)) ([ef17981](https://github.com/openai/openai-node/commit/ef17981a0bd6b3e971986ece829c5d260d7392d4))
* **internal:** run CI on update-specs branch ([9fc2130](https://github.com/openai/openai-node/commit/9fc2130b74a5919a3bbd41926903bdb310de4446))
* **internal:** update release workflows ([90b77d0](https://github.com/openai/openai-node/commit/90b77d09c04d21487aa38fe775c79ae632136813))

## 4.87.3 (2025-03-11)

Full Changelog: [v4.87.2...v4.87.3](https://github.com/openai/openai-node/compare/v4.87.2...v4.87.3)

### Bug Fixes

* **responses:** correct reasoning output type ([2abef57](https://github.com/openai/openai-node/commit/2abef57d7645a96a4b9a6b91483861cd568d2d4d))

## 4.87.2 (2025-03-11)

Full Changelog: [v4.87.1...v4.87.2](https://github.com/openai/openai-node/compare/v4.87.1...v4.87.2)

### Bug Fixes

* **responses:** correctly add output_text ([4ceb5cc](https://github.com/openai/openai-node/commit/4ceb5cc516b8c75d46f0042534d7658796a8cd71))

## 4.87.1 (2025-03-11)

Full Changelog: [v4.87.0...v4.87.1](https://github.com/openai/openai-node/compare/v4.87.0...v4.87.1)

### Bug Fixes

* correct imports ([5cdf17c](https://github.com/openai/openai-node/commit/5cdf17cec33da7cf540b8bdbcfa30c0c52842dd1))

## 4.87.0 (2025-03-11)

Full Changelog: [v4.86.2...v4.87.0](https://github.com/openai/openai-node/compare/v4.86.2...v4.87.0)

### Features

* **api:** add /v1/responses and built-in tools ([119b584](https://github.com/openai/openai-node/commit/119b5843a18b8014167c8d2031d75c08dbf400a3))

## 4.86.2 (2025-03-05)

Full Changelog: [v4.86.1...v4.86.2](https://github.com/openai/openai-node/compare/v4.86.1...v4.86.2)

### Chores

* **internal:** run example files in CI ([#1357](https://github.com/openai/openai-node/issues/1357)) ([88d0050](https://github.com/openai/openai-node/commit/88d0050336749deb3810b4cb43473de1f84e42bd))

## 4.86.1 (2025-02-27)

Full Changelog: [v4.86.0...v4.86.1](https://github.com/openai/openai-node/compare/v4.86.0...v4.86.1)

### Documentation

* update URLs from stainlessapi.com to stainless.com ([#1352](https://github.com/openai/openai-node/issues/1352)) ([8294e9e](https://github.com/openai/openai-node/commit/8294e9ef57ed98722105b56d205ebea9d028f671))

## 4.86.0 (2025-02-27)

Full Changelog: [v4.85.4...v4.86.0](https://github.com/openai/openai-node/compare/v4.85.4...v4.86.0)

### Features

* **api:** add gpt-4.5-preview ([#1349](https://github.com/openai/openai-node/issues/1349)) ([2a1d36b](https://github.com/openai/openai-node/commit/2a1d36b560323fca058f98607775642370e90a47))

## 4.85.4 (2025-02-22)

Full Changelog: [v4.85.3...v4.85.4](https://github.com/openai/openai-node/compare/v4.85.3...v4.85.4)

### Chores

* **internal:** fix devcontainers setup ([#1343](https://github.com/openai/openai-node/issues/1343)) ([cb1ec90](https://github.com/openai/openai-node/commit/cb1ec907832e325bc29abe94ae325e0477cb87d1))

## 4.85.3 (2025-02-20)

Full Changelog: [v4.85.2...v4.85.3](https://github.com/openai/openai-node/compare/v4.85.2...v4.85.3)

### Bug Fixes

* **parsing:** remove tool_calls default empty array ([#1341](https://github.com/openai/openai-node/issues/1341)) ([2672160](https://github.com/openai/openai-node/commit/26721608e61949daa9592483e89b79230bb9198a))

## 4.85.2 (2025-02-18)

Full Changelog: [v4.85.1...v4.85.2](https://github.com/openai/openai-node/compare/v4.85.1...v4.85.2)

### Bug Fixes

* optimize sse chunk reading off-by-one error ([#1339](https://github.com/openai/openai-node/issues/1339)) ([c82795b](https://github.com/openai/openai-node/commit/c82795b189c73d1c0e3bc3a40d0d4a2558b0483a))

## 4.85.1 (2025-02-14)

Full Changelog: [v4.85.0...v4.85.1](https://github.com/openai/openai-node/compare/v4.85.0...v4.85.1)

### Bug Fixes

* **client:** fix export map for index exports ([#1328](https://github.com/openai/openai-node/issues/1328)) ([647ba7a](https://github.com/openai/openai-node/commit/647ba7a52311928f604c72b2cc95698c0837887f))
* **package:** add chat/completions.ts back in ([#1333](https://github.com/openai/openai-node/issues/1333)) ([e4b5546](https://github.com/openai/openai-node/commit/e4b554632ab1646da831f29413fefb3378c49cc1))


### Chores

* **internal:** add missing return type annotation ([#1334](https://github.com/openai/openai-node/issues/1334)) ([53e0856](https://github.com/openai/openai-node/commit/53e0856ec4d36deee4d71b5aaf436df0a59b9402))

## 4.85.0 (2025-02-13)

Full Changelog: [v4.84.1...v4.85.0](https://github.com/openai/openai-node/compare/v4.84.1...v4.85.0)

### Features

* **api:** add support for storing chat completions ([#1327](https://github.com/openai/openai-node/issues/1327)) ([8d77f8e](https://github.com/openai/openai-node/commit/8d77f8e3c4801b7fa1e7c6f50b48c1de1f43f3e6))


### Bug Fixes

* **realtime:** call .toString() on WebSocket url ([#1324](https://github.com/openai/openai-node/issues/1324)) ([09bc50d](https://github.com/openai/openai-node/commit/09bc50d439679b6acfd2441e69ee5aa18c00e5d9))

## 4.84.1 (2025-02-13)

Full Changelog: [v4.84.0...v4.84.1](https://github.com/openai/openai-node/compare/v4.84.0...v4.84.1)

### Bug Fixes

* **realtime:** correct websocket type var constraint ([#1321](https://github.com/openai/openai-node/issues/1321)) ([afb17ea](https://github.com/openai/openai-node/commit/afb17ea6497b860ebbe5d8e68e4a97681dd307ff))

## 4.84.0 (2025-02-12)

Full Changelog: [v4.83.0...v4.84.0](https://github.com/openai/openai-node/compare/v4.83.0...v4.84.0)

### Features

* **pagination:** avoid fetching when has_more: false ([#1305](https://github.com/openai/openai-node/issues/1305)) ([b6944c6](https://github.com/openai/openai-node/commit/b6944c634b53c9084f2ccf777c2491e89b2cc7af))


### Bug Fixes

* **api:** add missing reasoning effort + model enums ([#1302](https://github.com/openai/openai-node/issues/1302)) ([14c55c3](https://github.com/openai/openai-node/commit/14c55c312e31f1ed46d02f39a99049f785504a53))
* **assistants:** handle `thread.run.incomplete` event ([7032cc4](https://github.com/openai/openai-node/commit/7032cc40b8aa0a58459cf114bceb8028a8517400))
* correctly decode multi-byte characters over multiple chunks ([#1316](https://github.com/openai/openai-node/issues/1316)) ([dd776c4](https://github.com/openai/openai-node/commit/dd776c4867401f527f699bd4b9e567890256e849))


### Chores

* **internal:** remove segfault-handler dependency ([3521ca3](https://github.com/openai/openai-node/commit/3521ca34e7f5bd51542084e27c084a5d7cc5448b))


### Documentation

* **readme:** cleanup into multiple files ([da94424](https://github.com/openai/openai-node/commit/da944242e542e9e5e51cb11853c621fc6825ac02))

## 4.83.0 (2025-02-05)

Full Changelog: [v4.82.0...v4.83.0](https://github.com/openai/openai-node/compare/v4.82.0...v4.83.0)

### Features

* **client:** send `X-Stainless-Timeout` header ([#1299](https://github.com/openai/openai-node/issues/1299)) ([ddfc686](https://github.com/openai/openai-node/commit/ddfc686f43a3420c3adf8dec2e82b4d10a121eb8))


### Bug Fixes

* **api/types:** correct audio duration & role types ([#1300](https://github.com/openai/openai-node/issues/1300)) ([a955ac2](https://github.com/openai/openai-node/commit/a955ac2bf5bee663d530d0c82b0005bf3ce6fc47))
* **azure/audio:** use model param for deployments ([#1297](https://github.com/openai/openai-node/issues/1297)) ([85de382](https://github.com/openai/openai-node/commit/85de382db17cbe5f112650e79d0fc1cc841efbb2))

## 4.82.0 (2025-01-31)

Full Changelog: [v4.81.0...v4.82.0](https://github.com/openai/openai-node/compare/v4.81.0...v4.82.0)

### Features

* **api:** add o3-mini ([#1295](https://github.com/openai/openai-node/issues/1295)) ([378e2f7](https://github.com/openai/openai-node/commit/378e2f7af62c570adb4c7644a4d49576b698de41))


### Bug Fixes

* **examples/realtime:** remove duplicate `session.update` call ([#1293](https://github.com/openai/openai-node/issues/1293)) ([ad800b4](https://github.com/openai/openai-node/commit/ad800b4f9410c6838994c24a3386ea708717f72b))
* **types:** correct metadata type + other fixes ([378e2f7](https://github.com/openai/openai-node/commit/378e2f7af62c570adb4c7644a4d49576b698de41))

## 4.81.0 (2025-01-29)

Full Changelog: [v4.80.1...v4.81.0](https://github.com/openai/openai-node/compare/v4.80.1...v4.81.0)

### Features

* **azure:** Realtime API support ([#1287](https://github.com/openai/openai-node/issues/1287)) ([fe090c0](https://github.com/openai/openai-node/commit/fe090c0a57570217eb0b431e2cce40bf61de2b75))

## 4.80.1 (2025-01-24)

Full Changelog: [v4.80.0...v4.80.1](https://github.com/openai/openai-node/compare/v4.80.0...v4.80.1)

### Bug Fixes

* **azure:** include retry count header ([3e0ba40](https://github.com/openai/openai-node/commit/3e0ba409e57ce276fb1f95cd11c801e4ccaad572))


### Documentation

* fix typo, "zodFunctionTool" -&gt; "zodFunction" ([#1128](https://github.com/openai/openai-node/issues/1128)) ([b7ab6bb](https://github.com/openai/openai-node/commit/b7ab6bb304973ade94830f37eb646e800226d5ef))
* **helpers:** fix type annotation ([fc019df](https://github.com/openai/openai-node/commit/fc019df1d9cc276e8f8e689742853a09aa94991a))
* **readme:** fix realtime errors docs link ([#1286](https://github.com/openai/openai-node/issues/1286)) ([d1d50c8](https://github.com/openai/openai-node/commit/d1d50c897c18cefea964e8057fe1acfd766ae2bf))

## 4.80.0 (2025-01-22)

Full Changelog: [v4.79.4...v4.80.0](https://github.com/openai/openai-node/compare/v4.79.4...v4.80.0)

### Features

* **api:** update enum values, comments, and examples ([#1280](https://github.com/openai/openai-node/issues/1280)) ([d38f2c2](https://github.com/openai/openai-node/commit/d38f2c2648b6990f217c3c7d83ca31f3739641d3))

## 4.79.4 (2025-01-21)

Full Changelog: [v4.79.3...v4.79.4](https://github.com/openai/openai-node/compare/v4.79.3...v4.79.4)

### Bug Fixes

* **jsr:** correct zod config ([e45fa5f](https://github.com/openai/openai-node/commit/e45fa5f535ca74789636001e60e33edcad4db83c))


### Chores

* **internal:** minor restructuring ([#1278](https://github.com/openai/openai-node/issues/1278)) ([58ea92a](https://github.com/openai/openai-node/commit/58ea92a7464a04223f24ba31dbc0f7d0cf99cc19))


### Documentation

* update deprecation messages ([#1275](https://github.com/openai/openai-node/issues/1275)) ([1c6599e](https://github.com/openai/openai-node/commit/1c6599e47ef75a71cb309a1e14d97bc97bd036d0))

## 4.79.3 (2025-01-21)

Full Changelog: [v4.79.2...v4.79.3](https://github.com/openai/openai-node/compare/v4.79.2...v4.79.3)

### Bug Fixes

* **jsr:** export zod helpers ([9dc55b6](https://github.com/openai/openai-node/commit/9dc55b62b564ad5ad1d4a60fe520b68235d05296))

## 4.79.2 (2025-01-21)

Full Changelog: [v4.79.1...v4.79.2](https://github.com/openai/openai-node/compare/v4.79.1...v4.79.2)

### Chores

* **internal:** add test ([#1270](https://github.com/openai/openai-node/issues/1270)) ([b7c2d3d](https://github.com/openai/openai-node/commit/b7c2d3d9abd315f1452a578b0fd0d82e6ac4ff60))


### Documentation

* **readme:** fix Realtime API example link ([#1272](https://github.com/openai/openai-node/issues/1272)) ([d0653c7](https://github.com/openai/openai-node/commit/d0653c7fef48360d137a7411dfdfb95d477cdbc5))

## 4.79.1 (2025-01-17)

Full Changelog: [v4.79.0...v4.79.1](https://github.com/openai/openai-node/compare/v4.79.0...v4.79.1)

### Bug Fixes

* **realtime:** correct import syntax ([#1267](https://github.com/openai/openai-node/issues/1267)) ([74702a7](https://github.com/openai/openai-node/commit/74702a739f566810d2b6c4e0832cfa17a1d1e272))

## 4.79.0 (2025-01-17)

Full Changelog: [v4.78.1...v4.79.0](https://github.com/openai/openai-node/compare/v4.78.1...v4.79.0)

### Features

* **client:** add Realtime API support ([#1266](https://github.com/openai/openai-node/issues/1266)) ([7160ebe](https://github.com/openai/openai-node/commit/7160ebe647769fbf48a600c9961d1a6f86dc9622))


### Bug Fixes

* **logs/azure:** redact sensitive header when DEBUG is set ([#1218](https://github.com/openai/openai-node/issues/1218)) ([6a72fd7](https://github.com/openai/openai-node/commit/6a72fd736733db19504a829bf203b39d5b9e3644))


### Chores

* fix streaming ([379c743](https://github.com/openai/openai-node/commit/379c7435ed5d508458e9cdc22386039b84fcec5e))
* **internal:** streaming refactors ([#1261](https://github.com/openai/openai-node/issues/1261)) ([dd4af93](https://github.com/openai/openai-node/commit/dd4af939792583854a313367c5fe2f98eea2f3c8))
* **types:** add `| undefined` to client options properties ([#1264](https://github.com/openai/openai-node/issues/1264)) ([5e56979](https://github.com/openai/openai-node/commit/5e569799b9ac8f915b16de90d91d38b568c1edce))
* **types:** rename vector store chunking strategy ([#1263](https://github.com/openai/openai-node/issues/1263)) ([d31acee](https://github.com/openai/openai-node/commit/d31acee860c80ba945d4e70b956c7ed75f5f849a))

## 4.78.1 (2025-01-10)

Full Changelog: [v4.78.0...v4.78.1](https://github.com/openai/openai-node/compare/v4.78.0...v4.78.1)

### Bug Fixes

* send correct Accept header for certain endpoints ([#1257](https://github.com/openai/openai-node/issues/1257)) ([8756693](https://github.com/openai/openai-node/commit/8756693c5690b16045cdd8d33636fe7643d45f3a))

## 4.78.0 (2025-01-09)

Full Changelog: [v4.77.4...v4.78.0](https://github.com/openai/openai-node/compare/v4.77.4...v4.78.0)

### Features

* **client:** add realtime types ([#1254](https://github.com/openai/openai-node/issues/1254)) ([7130995](https://github.com/openai/openai-node/commit/71309957a9a0883cac84b8b57697b796a9df3503))

## 4.77.4 (2025-01-08)

Full Changelog: [v4.77.3...v4.77.4](https://github.com/openai/openai-node/compare/v4.77.3...v4.77.4)

### Documentation

* **readme:** fix misplaced period ([#1252](https://github.com/openai/openai-node/issues/1252)) ([c2fe465](https://github.com/openai/openai-node/commit/c2fe46522d59d1611ba8bb2b7e070f9be7264df0))

## 4.77.3 (2025-01-03)

Full Changelog: [v4.77.2...v4.77.3](https://github.com/openai/openai-node/compare/v4.77.2...v4.77.3)

### Chores

* **api:** bump spec version ([#1248](https://github.com/openai/openai-node/issues/1248)) ([37b3df9](https://github.com/openai/openai-node/commit/37b3df9ac6af76fea6eace8307aab9f0565e5660))

## 4.77.2 (2025-01-02)

Full Changelog: [v4.77.1...v4.77.2](https://github.com/openai/openai-node/compare/v4.77.1...v4.77.2)

### Chores

* bump license year ([#1246](https://github.com/openai/openai-node/issues/1246)) ([13197c1](https://github.com/openai/openai-node/commit/13197c1698f492529bd00b62d95f83c039ef0ac7))

## 4.77.1 (2024-12-21)

Full Changelog: [v4.77.0...v4.77.1](https://github.com/openai/openai-node/compare/v4.77.0...v4.77.1)

### Bug Fixes

* **client:** normalize method ([#1235](https://github.com/openai/openai-node/issues/1235)) ([4a213da](https://github.com/openai/openai-node/commit/4a213dad6f2104dc02a75724acc62134d25db472))


### Chores

* **internal:** spec update ([#1231](https://github.com/openai/openai-node/issues/1231)) ([a97ea73](https://github.com/openai/openai-node/commit/a97ea73cafcb56e94be7ff691c4022da575cf60e))


### Documentation

* minor formatting changes ([#1236](https://github.com/openai/openai-node/issues/1236)) ([6387968](https://github.com/openai/openai-node/commit/63879681ccaca3dc1e17b27464e2f830b8f63b4f))
* **readme:** add alpha callout ([f2eff37](https://github.com/openai/openai-node/commit/f2eff3780e1216f7f420f7b86d47f4e21986b10e))

## 4.77.0 (2024-12-17)

Full Changelog: [v4.76.3...v4.77.0](https://github.com/openai/openai-node/compare/v4.76.3...v4.77.0)

### Features

* **api:** new o1 and GPT-4o models + preference fine-tuning ([#1229](https://github.com/openai/openai-node/issues/1229)) ([2e872d4](https://github.com/openai/openai-node/commit/2e872d4ac3717ab8f61741efffb7a31acd798338))


### Chores

* **internal:** fix some typos ([#1227](https://github.com/openai/openai-node/issues/1227)) ([d51fcfe](https://github.com/openai/openai-node/commit/d51fcfe3a66550a684eeeb0e6f17e1d9825cdf78))
* **internal:** spec update ([#1230](https://github.com/openai/openai-node/issues/1230)) ([ed2b61d](https://github.com/openai/openai-node/commit/ed2b61d32703b64d9f91223bc02627a607f60483))

## 4.76.3 (2024-12-13)

Full Changelog: [v4.76.2...v4.76.3](https://github.com/openai/openai-node/compare/v4.76.2...v4.76.3)

### Chores

* **internal:** better ecosystem test debugging ([86fc0a8](https://github.com/openai/openai-node/commit/86fc0a81ede2780d3fcebaabff3d9fa9a36cc9c0))


### Documentation

* **README:** fix helpers section links ([#1224](https://github.com/openai/openai-node/issues/1224)) ([efbe30a](https://github.com/openai/openai-node/commit/efbe30a156cec1836d3db28f663066b33be57ba2))

## 4.76.2 (2024-12-12)

Full Changelog: [v4.76.1...v4.76.2](https://github.com/openai/openai-node/compare/v4.76.1...v4.76.2)

### Chores

* **internal:** update isAbsoluteURL ([#1223](https://github.com/openai/openai-node/issues/1223)) ([e908ed7](https://github.com/openai/openai-node/commit/e908ed759996fb7706baf46d094fc77419423971))
* **types:** nicer error class types + jsdocs ([#1219](https://github.com/openai/openai-node/issues/1219)) ([576d24c](https://github.com/openai/openai-node/commit/576d24cc4b3d766dfe28a6031bdc24ac1b711655))

## 4.76.1 (2024-12-10)

Full Changelog: [v4.76.0...v4.76.1](https://github.com/openai/openai-node/compare/v4.76.0...v4.76.1)

### Chores

* **internal:** bump cross-spawn to v7.0.6 ([#1217](https://github.com/openai/openai-node/issues/1217)) ([c07ad29](https://github.com/openai/openai-node/commit/c07ad298d58e5aeaf816ee3de65fd59bf3fc8b66))
* **internal:** remove unnecessary getRequestClient function ([#1215](https://github.com/openai/openai-node/issues/1215)) ([bef3925](https://github.com/openai/openai-node/commit/bef392526cd339f45c574bc476649c77be36c612))

## 4.76.0 (2024-12-05)

Full Changelog: [v4.75.0...v4.76.0](https://github.com/openai/openai-node/compare/v4.75.0...v4.76.0)

### Features

* **api:** updates ([#1212](https://github.com/openai/openai-node/issues/1212)) ([e0fedf2](https://github.com/openai/openai-node/commit/e0fedf2c5a91d0c03d8dad6854b366f77eab4923))


### Chores

* bump openapi url ([#1210](https://github.com/openai/openai-node/issues/1210)) ([3fa95a4](https://github.com/openai/openai-node/commit/3fa95a429d4b2adecce35a7b96b73f6d5e88eeeb))

## 4.75.0 (2024-12-03)

Full Changelog: [v4.74.0...v4.75.0](https://github.com/openai/openai-node/compare/v4.74.0...v4.75.0)

### Features

* improve docs for jsr README.md ([#1208](https://github.com/openai/openai-node/issues/1208)) ([338527e](https://github.com/openai/openai-node/commit/338527e40361e2de899a63f280d4ec2db5e87f3c))

## 4.74.0 (2024-12-02)

Full Changelog: [v4.73.1...v4.74.0](https://github.com/openai/openai-node/compare/v4.73.1...v4.74.0)

### Features

* **internal:** make git install file structure match npm ([#1204](https://github.com/openai/openai-node/issues/1204)) ([e7c4c6d](https://github.com/openai/openai-node/commit/e7c4c6d23adbe52300053a8d35db6e341c438703))

## 4.73.1 (2024-11-25)

Full Changelog: [v4.73.0...v4.73.1](https://github.com/openai/openai-node/compare/v4.73.0...v4.73.1)

### Documentation

* **readme:** mention `.withResponse()` for streaming request ID ([#1202](https://github.com/openai/openai-node/issues/1202)) ([b6800d4](https://github.com/openai/openai-node/commit/b6800d4dea2729fe3b0864171ce8fb3b2cc1b21c))

## 4.73.0 (2024-11-20)

Full Changelog: [v4.72.0...v4.73.0](https://github.com/openai/openai-node/compare/v4.72.0...v4.73.0)

### Features

* **api:** add gpt-4o-2024-11-20 model ([#1201](https://github.com/openai/openai-node/issues/1201)) ([0feeafd](https://github.com/openai/openai-node/commit/0feeafd21ba4b6281cc3b9dafa2919b1e2e4d1c3))
* bump model in all example snippets to gpt-4o ([6961c37](https://github.com/openai/openai-node/commit/6961c37f2e581bcc12ec2bbe77df2b9b260fe297))


### Bug Fixes

* **docs:** add missing await to pagination example ([#1190](https://github.com/openai/openai-node/issues/1190)) ([524b9e8](https://github.com/openai/openai-node/commit/524b9e82ae13a3b5093dcfbfd1169a798cf99ab4))


### Chores

* **client:** drop unused devDependency ([#1191](https://github.com/openai/openai-node/issues/1191)) ([8ee6c03](https://github.com/openai/openai-node/commit/8ee6c0335673f2ecf84ea11bdfc990adab607e20))
* **internal:** spec update ([#1195](https://github.com/openai/openai-node/issues/1195)) ([12f9334](https://github.com/openai/openai-node/commit/12f93346857196b93f94865cc3744d769e5e519c))
* **internal:** use reexports not destructuring ([#1181](https://github.com/openai/openai-node/issues/1181)) ([f555dd6](https://github.com/openai/openai-node/commit/f555dd6503bc4ccd4d13f4e1a1d36fbbfd51c369))


### Documentation

* bump models in example snippets to gpt-4o ([#1184](https://github.com/openai/openai-node/issues/1184)) ([4ec4027](https://github.com/openai/openai-node/commit/4ec402790cf3cfbccbf3ef9b61d577b0118977e8))
* change readme title ([#1198](https://github.com/openai/openai-node/issues/1198)) ([e34981c](https://github.com/openai/openai-node/commit/e34981c00f2f0360baffe870bcc38786030671bf))
* improve jsr documentation ([#1197](https://github.com/openai/openai-node/issues/1197)) ([ebdb4f7](https://github.com/openai/openai-node/commit/ebdb4f72cc01afbee649aca009fdaf413e61c507))
* **readme:** fix incorrect fileBatches.uploadAndPoll params ([#1200](https://github.com/openai/openai-node/issues/1200)) ([3968ef1](https://github.com/openai/openai-node/commit/3968ef1c4fa860ff246e0e803808752b261c18ce))

## 4.72.0 (2024-11-12)

Full Changelog: [v4.71.1...v4.72.0](https://github.com/openai/openai-node/compare/v4.71.1...v4.72.0)

### Features

* add back deno runtime testing without type checks ([1626cf5](https://github.com/openai/openai-node/commit/1626cf57e94706e1fc8b2f9ff4f173fe486d5150))


### Chores

* **ecosystem-tests:** bump wrangler version ([#1178](https://github.com/openai/openai-node/issues/1178)) ([4dfb0c6](https://github.com/openai/openai-node/commit/4dfb0c6aa7c4530665bc7d6beebcd04aa1490e27))

## 4.71.1 (2024-11-06)

Full Changelog: [v4.71.0...v4.71.1](https://github.com/openai/openai-node/compare/v4.71.0...v4.71.1)

### Bug Fixes

* change release please configuration for jsr.json ([#1174](https://github.com/openai/openai-node/issues/1174)) ([c39efba](https://github.com/openai/openai-node/commit/c39efba812209c8906315596cc0a56e54ae8590a))

## 4.71.0 (2024-11-04)

Full Changelog: [v4.70.3...v4.71.0](https://github.com/openai/openai-node/compare/v4.70.3...v4.71.0)

### Features

* **api:** add support for predicted outputs ([#1172](https://github.com/openai/openai-node/issues/1172)) ([08a7bb4](https://github.com/openai/openai-node/commit/08a7bb4d4b751aeed9655bfcb9fa27fc79a767c4))

## 4.70.3 (2024-11-04)

Full Changelog: [v4.70.2...v4.70.3](https://github.com/openai/openai-node/compare/v4.70.2...v4.70.3)

### Bug Fixes

* change streaming helper imports to be relative ([e73b7cf](https://github.com/openai/openai-node/commit/e73b7cf84272bd02a39a67795d49db23db2d970f))

## 4.70.2 (2024-11-01)

Full Changelog: [v4.70.1...v4.70.2](https://github.com/openai/openai-node/compare/v4.70.1...v4.70.2)

### Bug Fixes

* add permissions to github workflow ([ee75e00](https://github.com/openai/openai-node/commit/ee75e00b0fbf82553b219ee8948a8077e9c26a24))
* skip deno ecosystem test ([5b181b0](https://github.com/openai/openai-node/commit/5b181b01b62139f8da35d426914c82b8425af141))

## 4.70.1 (2024-11-01)

Full Changelog: [v4.70.0...v4.70.1](https://github.com/openai/openai-node/compare/v4.70.0...v4.70.1)

### Bug Fixes

* don't require deno to run build-deno ([#1167](https://github.com/openai/openai-node/issues/1167)) ([9d857bc](https://github.com/openai/openai-node/commit/9d857bc531a0bb3939f7660e49b31ccc38f60dd3))

## 4.70.0 (2024-11-01)

Full Changelog: [v4.69.0...v4.70.0](https://github.com/openai/openai-node/compare/v4.69.0...v4.70.0)

### Features

* publish to jsr ([#1165](https://github.com/openai/openai-node/issues/1165)) ([5aa93a7](https://github.com/openai/openai-node/commit/5aa93a7fe704ef1ad077787852db38dc29104534))


### Chores

* **internal:** fix isolated modules exports ([9cd1958](https://github.com/openai/openai-node/commit/9cd19584dcc6f4004ea1adcee917aa88a37d5f1c))


### Refactors

* use type imports for type-only imports ([#1159](https://github.com/openai/openai-node/issues/1159)) ([07bbaf6](https://github.com/openai/openai-node/commit/07bbaf6ecac9a5e36471a35488020853ddf9214f))

## 4.69.0 (2024-10-30)

Full Changelog: [v4.68.4...v4.69.0](https://github.com/openai/openai-node/compare/v4.68.4...v4.69.0)

### Features

* **api:** add new, expressive voices for Realtime and Audio in Chat Completions ([#1157](https://github.com/openai/openai-node/issues/1157)) ([12e501c](https://github.com/openai/openai-node/commit/12e501c8a215a2af29b9b8fceedc5935b6f2feef))


### Bug Fixes

* **internal:** support pnpm git installs ([#1156](https://github.com/openai/openai-node/issues/1156)) ([b744c5b](https://github.com/openai/openai-node/commit/b744c5b609533e9a6694d6cae0425fe9cd37e26c))


### Documentation

* **readme:** minor typo fixes ([#1154](https://github.com/openai/openai-node/issues/1154)) ([c6c9f9a](https://github.com/openai/openai-node/commit/c6c9f9aaf75f643016ad73574a7e24a228b5c60f))

## 4.68.4 (2024-10-23)

Full Changelog: [v4.68.3...v4.68.4](https://github.com/openai/openai-node/compare/v4.68.3...v4.68.4)

### Chores

* **internal:** update spec version ([#1146](https://github.com/openai/openai-node/issues/1146)) ([0165a8d](https://github.com/openai/openai-node/commit/0165a8d79340ede49557e05fd00d6fff9d69d930))

## 4.68.3 (2024-10-23)

Full Changelog: [v4.68.2...v4.68.3](https://github.com/openai/openai-node/compare/v4.68.2...v4.68.3)

### Chores

* **internal:** bumps eslint and related dependencies ([#1143](https://github.com/openai/openai-node/issues/1143)) ([2643f42](https://github.com/openai/openai-node/commit/2643f42a36208c36daf23470ffcd227a891284eb))

## 4.68.2 (2024-10-22)

Full Changelog: [v4.68.1...v4.68.2](https://github.com/openai/openai-node/compare/v4.68.1...v4.68.2)

### Chores

* **internal:** update spec version ([#1141](https://github.com/openai/openai-node/issues/1141)) ([2ccb3e3](https://github.com/openai/openai-node/commit/2ccb3e357aa2f3eb0fa32c619d8336c3b94cc882))

## 4.68.1 (2024-10-18)

Full Changelog: [v4.68.0...v4.68.1](https://github.com/openai/openai-node/compare/v4.68.0...v4.68.1)

### Bug Fixes

* **client:** respect x-stainless-retry-count default headers ([#1138](https://github.com/openai/openai-node/issues/1138)) ([266717b](https://github.com/openai/openai-node/commit/266717b3301828c7df735064a380a055576183bc))

## 4.68.0 (2024-10-17)

Full Changelog: [v4.67.3...v4.68.0](https://github.com/openai/openai-node/compare/v4.67.3...v4.68.0)

### Features

* **api:** add gpt-4o-audio-preview model for chat completions ([#1135](https://github.com/openai/openai-node/issues/1135)) ([17a623f](https://github.com/openai/openai-node/commit/17a623f70050bca4538ad2939055cd9d9b165f89))

## 4.67.3 (2024-10-08)

Full Changelog: [v4.67.2...v4.67.3](https://github.com/openai/openai-node/compare/v4.67.2...v4.67.3)

### Chores

* **internal:** pass props through internal parser ([#1125](https://github.com/openai/openai-node/issues/1125)) ([5ef8aa8](https://github.com/openai/openai-node/commit/5ef8aa8d308f7374dd01d8079cd76e0d96999ec2))

## 4.67.2 (2024-10-07)

Full Changelog: [v4.67.1...v4.67.2](https://github.com/openai/openai-node/compare/v4.67.1...v4.67.2)

### Chores

* **internal:** move LineDecoder to a separate file ([#1120](https://github.com/openai/openai-node/issues/1120)) ([0a4be65](https://github.com/openai/openai-node/commit/0a4be6506bf26d2b9552ff3fd13a22c04b53ea18))

## 4.67.1 (2024-10-02)

Full Changelog: [v4.67.0...v4.67.1](https://github.com/openai/openai-node/compare/v4.67.0...v4.67.1)

### Documentation

* improve and reference contributing documentation ([#1115](https://github.com/openai/openai-node/issues/1115)) ([7fa30b3](https://github.com/openai/openai-node/commit/7fa30b3ebf276556141df95ba8e824a0276b61f8))

## 4.67.0 (2024-10-01)

Full Changelog: [v4.66.1...v4.67.0](https://github.com/openai/openai-node/compare/v4.66.1...v4.67.0)

### Features

* **api:** support storing chat completions, enabling evals and model distillation in the dashboard ([#1112](https://github.com/openai/openai-node/issues/1112)) ([6424924](https://github.com/openai/openai-node/commit/6424924b6361e54f07c04fce9075ab16fcb712fb))

## 4.66.1 (2024-09-30)

Full Changelog: [v4.66.0...v4.66.1](https://github.com/openai/openai-node/compare/v4.66.0...v4.66.1)

### Bug Fixes

* **audio:** add fallback overload types ([0c00a13](https://github.com/openai/openai-node/commit/0c00a13dd864b974d3376c905647209e4a79f244))
* **audio:** use export type ([1519100](https://github.com/openai/openai-node/commit/1519100e530e08e7683549d0bcdd919b9c2d1654))

## 4.66.0 (2024-09-27)

Full Changelog: [v4.65.0...v4.66.0](https://github.com/openai/openai-node/compare/v4.65.0...v4.66.0)

### Features

* **client:** add request_id to `.withResponse()` ([#1095](https://github.com/openai/openai-node/issues/1095)) ([2d0f565](https://github.com/openai/openai-node/commit/2d0f565f124a8862bc24214cc3ddce9db0ba75bc))


### Bug Fixes

* **audio:** correct types for transcriptions / translations ([#1104](https://github.com/openai/openai-node/issues/1104)) ([96e86c2](https://github.com/openai/openai-node/commit/96e86c214ba79d50035b61e5daa3489f082512c4))
* **client:** correct types for transcriptions / translations ([#1105](https://github.com/openai/openai-node/issues/1105)) ([fa16ebb](https://github.com/openai/openai-node/commit/fa16ebbb314ebc7c274d27f0148d248edf48e055))

## 4.65.0 (2024-09-26)

Full Changelog: [v4.64.0...v4.65.0](https://github.com/openai/openai-node/compare/v4.64.0...v4.65.0)

### Features

* **api:** add omni-moderation model ([#1100](https://github.com/openai/openai-node/issues/1100)) ([66c0f21](https://github.com/openai/openai-node/commit/66c0f21fad3be9c57b810c4a7eebb71eb6ccbcc1))

## 4.64.0 (2024-09-25)

Full Changelog: [v4.63.0...v4.64.0](https://github.com/openai/openai-node/compare/v4.63.0...v4.64.0)

### Features

* **client:** allow overriding retry count header ([#1098](https://github.com/openai/openai-node/issues/1098)) ([a466ff7](https://github.com/openai/openai-node/commit/a466ff78a436db82d79a8f53066a85a3b1dbe039))


### Bug Fixes

* **audio:** correct response_format translations type ([#1097](https://github.com/openai/openai-node/issues/1097)) ([9a5f461](https://github.com/openai/openai-node/commit/9a5f461306e84b62ce1ed8aedbfee90798def5fb))


### Chores

* **internal:** fix ecosystem tests error output ([#1096](https://github.com/openai/openai-node/issues/1096)) ([ecdb4e9](https://github.com/openai/openai-node/commit/ecdb4e923f94e828d8758559aea78c82417b8f12))
* **internal:** fix slow ecosystem test ([#1093](https://github.com/openai/openai-node/issues/1093)) ([80ed9ec](https://github.com/openai/openai-node/commit/80ed9ecbd60129164cb407e46dddbc06ef1c54ab))

## 4.63.0 (2024-09-20)

Full Changelog: [v4.62.1...v4.63.0](https://github.com/openai/openai-node/compare/v4.62.1...v4.63.0)

### Features

* **client:** send retry count header ([#1087](https://github.com/openai/openai-node/issues/1087)) ([7bcebc0](https://github.com/openai/openai-node/commit/7bcebc0e3965c2decd1dffb1e67f5197260ca89e))


### Chores

* **types:** improve type name for embedding models ([#1089](https://github.com/openai/openai-node/issues/1089)) ([d6966d9](https://github.com/openai/openai-node/commit/d6966d9872a14b7fbee85a7bb1fae697852b8ce0))

## 4.62.1 (2024-09-18)

Full Changelog: [v4.62.0...v4.62.1](https://github.com/openai/openai-node/compare/v4.62.0...v4.62.1)

### Bug Fixes

* **types:** remove leftover polyfill usage ([#1084](https://github.com/openai/openai-node/issues/1084)) ([b7c9538](https://github.com/openai/openai-node/commit/b7c9538981a11005fb0a00774683d979d3ca663a))

## 4.62.0 (2024-09-17)

Full Changelog: [v4.61.1...v4.62.0](https://github.com/openai/openai-node/compare/v4.61.1...v4.62.0)

### Features

* **client:** add ._request_id property to object responses ([#1078](https://github.com/openai/openai-node/issues/1078)) ([d5c2131](https://github.com/openai/openai-node/commit/d5c21314449091dd1c668c7358b25e041466f588))


### Chores

* **internal:** add ecosystem test for qs reproduction ([0199dd8](https://github.com/openai/openai-node/commit/0199dd85981497fac2b60f786acc00ea30683897))
* **internal:** add query string encoder ([#1079](https://github.com/openai/openai-node/issues/1079)) ([f870682](https://github.com/openai/openai-node/commit/f870682d5c490182547c428b0b5c75da0e34d15a))
* **internal:** fix some types ([#1082](https://github.com/openai/openai-node/issues/1082)) ([1ec41a7](https://github.com/openai/openai-node/commit/1ec41a7d768502a31abb33bf86b0539e5b4b6541))
* **tests:** add query string tests to ecosystem tests ([36be724](https://github.com/openai/openai-node/commit/36be724384401bb697d8b07b0a1965be721cfa51))

## 4.61.1 (2024-09-16)

Full Changelog: [v4.61.0...v4.61.1](https://github.com/openai/openai-node/compare/v4.61.0...v4.61.1)

### Bug Fixes

* **runTools:** correct request options type ([#1073](https://github.com/openai/openai-node/issues/1073)) ([399f971](https://github.com/openai/openai-node/commit/399f9710f9a1406fe2dd048a1d26418c0de7ff0c))


### Chores

* **internal:** update spec link ([#1076](https://github.com/openai/openai-node/issues/1076)) ([20f1bcc](https://github.com/openai/openai-node/commit/20f1bcce2b5d03c5185989212a5c5271a8d4209c))

## 4.61.0 (2024-09-13)

Full Changelog: [v4.60.1...v4.61.0](https://github.com/openai/openai-node/compare/v4.60.1...v4.61.0)

### Bug Fixes

* **client:** partial parsing update to handle strings ([46e8eb6](https://github.com/openai/openai-node/commit/46e8eb6a9a45b11f9e4c97474ed6c02b1faa43af))
* **examples:** handle usage chunk in tool call streaming ([#1068](https://github.com/openai/openai-node/issues/1068)) ([e4188c4](https://github.com/openai/openai-node/commit/e4188c4ba443a21d1ef94658df5366f80f0e573b))


### Chores

* **examples:** add a small delay to tool-calls example streaming ([a3fc659](https://github.com/openai/openai-node/commit/a3fc65928af7085d1d8d785ad4765fedc3955641))


### Documentation

* update CONTRIBUTING.md ([#1071](https://github.com/openai/openai-node/issues/1071)) ([5de81c9](https://github.com/openai/openai-node/commit/5de81c95d7326602865e007715a76d5595824fd9))

## 4.60.1 (2024-09-13)

Full Changelog: [v4.60.0...v4.60.1](https://github.com/openai/openai-node/compare/v4.60.0...v4.60.1)

### Bug Fixes

* **zod:** correctly add $ref definitions for transformed schemas ([#1065](https://github.com/openai/openai-node/issues/1065)) ([9b93b24](https://github.com/openai/openai-node/commit/9b93b24b8ae267fe403fb9cd4876d9772f40878b))

## 4.60.0 (2024-09-12)

Full Changelog: [v4.59.0...v4.60.0](https://github.com/openai/openai-node/compare/v4.59.0...v4.60.0)

### Features

* **api:** add o1 models ([#1061](https://github.com/openai/openai-node/issues/1061)) ([224cc04](https://github.com/openai/openai-node/commit/224cc045200cd1ce1517b4376c505de9b9a74ccc))

## 4.59.0 (2024-09-11)

Full Changelog: [v4.58.2...v4.59.0](https://github.com/openai/openai-node/compare/v4.58.2...v4.59.0)

### Features

* **structured outputs:** support accessing raw responses ([#1058](https://github.com/openai/openai-node/issues/1058)) ([af17697](https://github.com/openai/openai-node/commit/af176979894ee95a51e09abc239a8fd3a639dcde))


### Documentation

* **azure:** example for custom base URL ([#1055](https://github.com/openai/openai-node/issues/1055)) ([20defc8](https://github.com/openai/openai-node/commit/20defc80801e1f1f489a07bd1264be71c56c586f))
* **azure:** remove locale from docs link ([#1054](https://github.com/openai/openai-node/issues/1054)) ([f9b7eac](https://github.com/openai/openai-node/commit/f9b7eac58020cff0e367a15b9a2ca4e7c95cbb89))

## 4.58.2 (2024-09-09)

Full Changelog: [v4.58.1...v4.58.2](https://github.com/openai/openai-node/compare/v4.58.1...v4.58.2)

### Bug Fixes

* **errors:** pass message through to APIConnectionError ([#1050](https://github.com/openai/openai-node/issues/1050)) ([5a34316](https://github.com/openai/openai-node/commit/5a3431672e200a6bc161d39873e914434557801e))


### Chores

* better object fallback behaviour for casting errors ([#1053](https://github.com/openai/openai-node/issues/1053)) ([b7d4619](https://github.com/openai/openai-node/commit/b7d46190d2bb775145a9a3de6408c38abacfa055))

## 4.58.1 (2024-09-06)

Full Changelog: [v4.58.0...v4.58.1](https://github.com/openai/openai-node/compare/v4.58.0...v4.58.1)

### Chores

* **docs:** update browser support information ([#1045](https://github.com/openai/openai-node/issues/1045)) ([d326cc5](https://github.com/openai/openai-node/commit/d326cc54a77c450672fbf07d736cec80a9ba72fb))

## 4.58.0 (2024-09-05)

Full Changelog: [v4.57.3...v4.58.0](https://github.com/openai/openai-node/compare/v4.57.3...v4.58.0)

### Features

* **vector store:** improve chunking strategy type names ([#1041](https://github.com/openai/openai-node/issues/1041)) ([471cec3](https://github.com/openai/openai-node/commit/471cec3228886253f07c13a362827a31e9ec7b63))


### Bug Fixes

* **uploads:** avoid making redundant memory copies ([#1043](https://github.com/openai/openai-node/issues/1043)) ([271297b](https://github.com/openai/openai-node/commit/271297bd32393d4c5663023adf82f8fb19dc3d25))

## 4.57.3 (2024-09-04)

Full Changelog: [v4.57.2...v4.57.3](https://github.com/openai/openai-node/compare/v4.57.2...v4.57.3)

### Bug Fixes

* **helpers/zod:** avoid import issue in certain environments ([#1039](https://github.com/openai/openai-node/issues/1039)) ([e238daa](https://github.com/openai/openai-node/commit/e238daa7c12f3fb13369f58b9d405365f5efcc8f))


### Chores

* **internal:** minor bump qs version ([#1037](https://github.com/openai/openai-node/issues/1037)) ([8ec218e](https://github.com/openai/openai-node/commit/8ec218e9efb657927b3c0346822a96872aeaf137))

## 4.57.2 (2024-09-04)

Full Changelog: [v4.57.1...v4.57.2](https://github.com/openai/openai-node/compare/v4.57.1...v4.57.2)

### Chores

* **internal:** dependency updates ([#1035](https://github.com/openai/openai-node/issues/1035)) ([e815fb6](https://github.com/openai/openai-node/commit/e815fb6dee75219563d3a7776774ba1c2984560e))

## 4.57.1 (2024-09-03)

Full Changelog: [v4.57.0...v4.57.1](https://github.com/openai/openai-node/compare/v4.57.0...v4.57.1)

### Bug Fixes

* **assistants:** correctly accumulate tool calls when streaming ([#1031](https://github.com/openai/openai-node/issues/1031)) ([d935ad3](https://github.com/openai/openai-node/commit/d935ad3fa37b2701f4c9f6e433ada6074280a871))
* **client:** correct File construction from node-fetch Responses ([#1029](https://github.com/openai/openai-node/issues/1029)) ([22ebdc2](https://github.com/openai/openai-node/commit/22ebdc2ca7d98e0f266110c4cf827e53a0a22026))
* runTools without stream should not emit user message events ([#1005](https://github.com/openai/openai-node/issues/1005)) ([22ded4d](https://github.com/openai/openai-node/commit/22ded4d549a157482a8de2faf65e92c5be07fa95))


### Chores

* **internal/tests:** workaround bug in recent types/node release ([3c7bdfd](https://github.com/openai/openai-node/commit/3c7bdfdb373bff77db0e3fecd5d49ddfa4284cd9))

## 4.57.0 (2024-08-29)

Full Changelog: [v4.56.2...v4.57.0](https://github.com/openai/openai-node/compare/v4.56.2...v4.57.0)

### Features

* **api:** add file search result details to run steps ([#1023](https://github.com/openai/openai-node/issues/1023)) ([d9acd0a](https://github.com/openai/openai-node/commit/d9acd0a2c52b27983f8db6a8de6a776078b1d41b))


### Bug Fixes

* install examples deps as part of bootstrap script ([#1022](https://github.com/openai/openai-node/issues/1022)) ([eae8e36](https://github.com/openai/openai-node/commit/eae8e36fd5514eb60773646ec775badde50e783c))

## 4.56.2 (2024-08-29)

Full Changelog: [v4.56.1...v4.56.2](https://github.com/openai/openai-node/compare/v4.56.1...v4.56.2)

### Chores

* run tsc as part of lint script ([#1020](https://github.com/openai/openai-node/issues/1020)) ([4942347](https://github.com/openai/openai-node/commit/49423472f2b0a0b63961174bedfc00bfd99d47f9))

## 4.56.1 (2024-08-27)

Full Changelog: [v4.56.0...v4.56.1](https://github.com/openai/openai-node/compare/v4.56.0...v4.56.1)

### Chores

* **ci:** check for build errors ([#1013](https://github.com/openai/openai-node/issues/1013)) ([7ff2127](https://github.com/openai/openai-node/commit/7ff21273091a605e05173502654cfb9c90a4382e))

## 4.56.0 (2024-08-16)

Full Changelog: [v4.55.9...v4.56.0](https://github.com/openai/openai-node/compare/v4.55.9...v4.56.0)

### Features

* **api:** add chatgpt-4o-latest model ([edc4398](https://github.com/openai/openai-node/commit/edc43986ba96a0fda48f7eea368efe706f68dcac))

## 4.55.9 (2024-08-16)

Full Changelog: [v4.55.8...v4.55.9](https://github.com/openai/openai-node/compare/v4.55.8...v4.55.9)

### Bug Fixes

* **azure/tts:** avoid stripping model param ([#999](https://github.com/openai/openai-node/issues/999)) ([c3a7ccd](https://github.com/openai/openai-node/commit/c3a7ccdbd6d9a2576509c2dc6c1605bc73c6dde7))

## 4.55.8 (2024-08-15)

Full Changelog: [v4.55.7...v4.55.8](https://github.com/openai/openai-node/compare/v4.55.7...v4.55.8)

### Chores

* **types:** define FilePurpose enum ([#997](https://github.com/openai/openai-node/issues/997)) ([19b941b](https://github.com/openai/openai-node/commit/19b941be4ff3e4fa7e67b820a5aac51e5c8d4f60))

## 4.55.7 (2024-08-13)

Full Changelog: [v4.55.6...v4.55.7](https://github.com/openai/openai-node/compare/v4.55.6...v4.55.7)

### Bug Fixes

* **json-schema:** correct handling of nested recursive schemas ([#992](https://github.com/openai/openai-node/issues/992)) ([ac309ab](https://github.com/openai/openai-node/commit/ac309abee3419594f45680c7d0ab11e13ce28c5b))

## 4.55.6 (2024-08-13)

Full Changelog: [v4.55.5...v4.55.6](https://github.com/openai/openai-node/compare/v4.55.5...v4.55.6)

### Bug Fixes

* **zod-to-json-schema:** correct licensing ([#986](https://github.com/openai/openai-node/issues/986)) ([bd2051e](https://github.com/openai/openai-node/commit/bd2051e501e2ceafcd095f82205c2e668e1d68d7))

## 4.55.5 (2024-08-12)

Full Changelog: [v4.55.4...v4.55.5](https://github.com/openai/openai-node/compare/v4.55.4...v4.55.5)

### Chores

* **examples:** minor formatting changes ([#987](https://github.com/openai/openai-node/issues/987)) ([8e6b615](https://github.com/openai/openai-node/commit/8e6b615ada09fa4e50dc8e0b5decf662eed19856))
* sync openapi url ([#989](https://github.com/openai/openai-node/issues/989)) ([02ff1c5](https://github.com/openai/openai-node/commit/02ff1c55b5eefd8b6193ba2bf10dd5515945bd7a))

## 4.55.4 (2024-08-09)

Full Changelog: [v4.55.3...v4.55.4](https://github.com/openai/openai-node/compare/v4.55.3...v4.55.4)

### Bug Fixes

* **helpers/zod:** nested union schema extraction ([#979](https://github.com/openai/openai-node/issues/979)) ([31b05aa](https://github.com/openai/openai-node/commit/31b05aa6fa0445141ae17a1b1eff533b83735f3a))


### Chores

* **ci:** bump prism mock server version ([#982](https://github.com/openai/openai-node/issues/982)) ([7442643](https://github.com/openai/openai-node/commit/7442643e8445eea15da54843a7c9d7580a402979))
* **ci:** codeowners file ([#980](https://github.com/openai/openai-node/issues/980)) ([17a42b2](https://github.com/openai/openai-node/commit/17a42b2f6e2de2dce338358a48f6d7d4ed723f6f))

## 4.55.3 (2024-08-08)

Full Changelog: [v4.55.2...v4.55.3](https://github.com/openai/openai-node/compare/v4.55.2...v4.55.3)

### Chores

* **internal:** updates ([#975](https://github.com/openai/openai-node/issues/975)) ([313a190](https://github.com/openai/openai-node/commit/313a19059a61893887ac0b57bb488c24bc40f099))

## 4.55.2 (2024-08-08)

Full Changelog: [v4.55.1...v4.55.2](https://github.com/openai/openai-node/compare/v4.55.1...v4.55.2)

### Bug Fixes

* **helpers/zod:** add `extract-to-root` ref strategy ([ef3c73c](https://github.com/openai/openai-node/commit/ef3c73cfdf1a8e45346417812168e476fea65690))
* **helpers/zod:** add `nullableStrategy` option ([ad89892](https://github.com/openai/openai-node/commit/ad89892f4ac0daba161ce97267a165a12f67c341))
* **helpers/zod:** correct logic for adding root schema to definitions ([e4a247a](https://github.com/openai/openai-node/commit/e4a247a2a87b4d3bde55891b31e07413d3a9f00d))


### Chores

* **internal:** add README for vendored zod-to-json-schema ([d8a80a9](https://github.com/openai/openai-node/commit/d8a80a915dfe723a59f512e7128aecf857324388))
* **tests:** add more API request tests ([04c1590](https://github.com/openai/openai-node/commit/04c1590a64127c43898c3c88bcbdd624d54008f6))

## 4.55.1 (2024-08-07)

Full Changelog: [v4.55.0...v4.55.1](https://github.com/openai/openai-node/compare/v4.55.0...v4.55.1)

### Bug Fixes

* **helpers/zod:** correct schema generation for recursive schemas ([cb54d93](https://github.com/openai/openai-node/commit/cb54d93162c86ecfd476733805a431aab25d86d6))


### Chores

* **api:** remove old `AssistantResponseFormat` type ([#967](https://github.com/openai/openai-node/issues/967)) ([9fd94bf](https://github.com/openai/openai-node/commit/9fd94bfc35128d3bc45fbf0a65e6a8d2ea4562d5))
* **internal:** update test snapshots ([bceea60](https://github.com/openai/openai-node/commit/bceea60e461c40a9e59d52772122dd612a2ff1c4))
* **vendor/zodJsonSchema:** add option to duplicate top-level ref ([84b8a38](https://github.com/openai/openai-node/commit/84b8a3820b0ce1c78bfd3db468d8d2962875b4ab))


### Documentation

* **examples:** add UI generation example script ([c75c017](https://github.com/openai/openai-node/commit/c75c017c16cbfe3fc60ea4ee5779782005e64463))

## 4.55.0 (2024-08-06)

Full Changelog: [v4.54.0...v4.55.0](https://github.com/openai/openai-node/compare/v4.54.0...v4.55.0)

### Features

* **api:** add structured outputs support ([573787c](https://github.com/openai/openai-node/commit/573787cf3ea8eea593eeeb5e24a9256951e2cc35))

## 4.54.0 (2024-08-02)

Full Changelog: [v4.53.2...v4.54.0](https://github.com/openai/openai-node/compare/v4.53.2...v4.54.0)

### Features

* extract out `ImageModel`, `AudioModel`, `SpeechModel` ([#964](https://github.com/openai/openai-node/issues/964)) ([1edf957](https://github.com/openai/openai-node/commit/1edf957e1cb86c2a7b2d29e28f2b8f428ea0cd7d))
* make enums not nominal ([#965](https://github.com/openai/openai-node/issues/965)) ([0dd0cd1](https://github.com/openai/openai-node/commit/0dd0cd158d6765c3a04ac983aad03c2ecad14502))


### Chores

* **ci:** correctly tag pre-release npm packages ([#963](https://github.com/openai/openai-node/issues/963)) ([f1a4a68](https://github.com/openai/openai-node/commit/f1a4a686bbf4a38919b8597f008d895d1b99d8df))
* **internal:** add constant for default timeout ([#960](https://github.com/openai/openai-node/issues/960)) ([55c01f4](https://github.com/openai/openai-node/commit/55c01f4dc5d132c21713f9e8606b95abc76fcd44))
* **internal:** cleanup event stream helpers ([#950](https://github.com/openai/openai-node/issues/950)) ([8f49956](https://github.com/openai/openai-node/commit/8f499566c47bd7d4799a8cbe0d980553348b8f48))


### Documentation

* **README:** link Lifecycle in Polling Helpers section ([#962](https://github.com/openai/openai-node/issues/962)) ([c610c81](https://github.com/openai/openai-node/commit/c610c813e8d7f96b5b8315ae194e0a9ff565f43d))

## 4.53.2 (2024-07-26)

Full Changelog: [v4.53.1...v4.53.2](https://github.com/openai/openai-node/compare/v4.53.1...v4.53.2)

### Chores

* **docs:** fix incorrect client var names ([#955](https://github.com/openai/openai-node/issues/955)) ([cc91be8](https://github.com/openai/openai-node/commit/cc91be867bf7042abb2ee6c6d5ef69082ac64280))

## 4.53.1 (2024-07-25)

Full Changelog: [v4.53.0...v4.53.1](https://github.com/openai/openai-node/compare/v4.53.0...v4.53.1)

### Bug Fixes

* **compat:** remove ReadableStream polyfill redundant since node v16 ([#954](https://github.com/openai/openai-node/issues/954)) ([78b2a83](https://github.com/openai/openai-node/commit/78b2a83f085bb7ddf6a5f429636de1e3eef20f9d))


### Chores

* **tests:** update prism version ([#948](https://github.com/openai/openai-node/issues/948)) ([9202c91](https://github.com/openai/openai-node/commit/9202c91d697a116eb1b834e01f4073d254438149))

## 4.53.0 (2024-07-22)

Full Changelog: [v4.52.7...v4.53.0](https://github.com/openai/openai-node/compare/v4.52.7...v4.53.0)

### Features

* **api:** add new gpt-4o-mini models ([#942](https://github.com/openai/openai-node/issues/942)) ([7ac10dd](https://github.com/openai/openai-node/commit/7ac10ddbb87e9eb0e8e34d58a13a4775cbba1c24))
* **api:** add uploads endpoints ([#946](https://github.com/openai/openai-node/issues/946)) ([8709ceb](https://github.com/openai/openai-node/commit/8709ceb0e01c5a1f96704c998f35ca1117ecadac))


### Chores

* **docs:** mention support of web browser runtimes ([#938](https://github.com/openai/openai-node/issues/938)) ([123d19d](https://github.com/openai/openai-node/commit/123d19d5a157110c8ada556c107caf0eb8b2ccc6))
* **docs:** use client instead of package name in Node examples ([#941](https://github.com/openai/openai-node/issues/941)) ([8b5db1f](https://github.com/openai/openai-node/commit/8b5db1f53e66ce4b6e554f40a8dd2fd474085027))

## 4.52.7 (2024-07-11)

Full Changelog: [v4.52.6...v4.52.7](https://github.com/openai/openai-node/compare/v4.52.6...v4.52.7)

### Documentation

* **examples:** update example values ([#933](https://github.com/openai/openai-node/issues/933)) ([92512ab](https://github.com/openai/openai-node/commit/92512abcd7ab5d7c452dfae007c3a25041062656))

## 4.52.6 (2024-07-11)

Full Changelog: [v4.52.5...v4.52.6](https://github.com/openai/openai-node/compare/v4.52.5...v4.52.6)

### Chores

* **ci:** also run workflows for PRs targeting `next` ([#931](https://github.com/openai/openai-node/issues/931)) ([e3f979a](https://github.com/openai/openai-node/commit/e3f979ae94b2252b9552d1e03de5b92d398a3e28))

## 4.52.5 (2024-07-10)

Full Changelog: [v4.52.4...v4.52.5](https://github.com/openai/openai-node/compare/v4.52.4...v4.52.5)

### Bug Fixes

* **vectorStores:** correctly handle missing `files` in `uploadAndPoll()` ([#926](https://github.com/openai/openai-node/issues/926)) ([945fca6](https://github.com/openai/openai-node/commit/945fca646b02b52bbc9163cb51f5d87e7db8afd6))

## 4.52.4 (2024-07-08)

Full Changelog: [v4.52.3...v4.52.4](https://github.com/openai/openai-node/compare/v4.52.3...v4.52.4)

### Refactors

* **examples:** removedduplicated 'messageDelta' streaming event. ([#909](https://github.com/openai/openai-node/issues/909)) ([7b0b3d2](https://github.com/openai/openai-node/commit/7b0b3d2e228532fca19f49390a2831a1abac72a4))

## 4.52.3 (2024-07-02)

Full Changelog: [v4.52.2...v4.52.3](https://github.com/openai/openai-node/compare/v4.52.2...v4.52.3)

### Chores

* minor change to tests ([#916](https://github.com/openai/openai-node/issues/916)) ([b8a33e3](https://github.com/openai/openai-node/commit/b8a33e31697b52d733f28d9380e0c02a2d179474))

## 4.52.2 (2024-06-28)

Full Changelog: [v4.52.1...v4.52.2](https://github.com/openai/openai-node/compare/v4.52.1...v4.52.2)

### Chores

* gitignore test server logs ([#914](https://github.com/openai/openai-node/issues/914)) ([6316720](https://github.com/openai/openai-node/commit/6316720c3fdd0422965ae3890275062bc0fe3c2b))

## 4.52.1 (2024-06-25)

Full Changelog: [v4.52.0...v4.52.1](https://github.com/openai/openai-node/compare/v4.52.0...v4.52.1)

### Chores

* **doc:** clarify service tier default value ([#908](https://github.com/openai/openai-node/issues/908)) ([e4c8100](https://github.com/openai/openai-node/commit/e4c8100c7732bdc336b52a48d09945782c0fa2a3))
* **internal:** minor reformatting ([#911](https://github.com/openai/openai-node/issues/911)) ([78c9377](https://github.com/openai/openai-node/commit/78c9377fcd563645081629a89f3fda2c1ff4e175))
* **internal:** re-order some imports ([#904](https://github.com/openai/openai-node/issues/904)) ([dbd5c40](https://github.com/openai/openai-node/commit/dbd5c4053ba2f255dfc56676ced5b30381843c75))

## 4.52.0 (2024-06-18)

Full Changelog: [v4.51.0...v4.52.0](https://github.com/openai/openai-node/compare/v4.51.0...v4.52.0)

### Features

* **api:** add service tier argument for chat completions ([#900](https://github.com/openai/openai-node/issues/900)) ([91e6651](https://github.com/openai/openai-node/commit/91e66514037a8d6f9c39d3c96cd5769885925a4b))

## 4.51.0 (2024-06-12)

Full Changelog: [v4.50.0...v4.51.0](https://github.com/openai/openai-node/compare/v4.50.0...v4.51.0)

### Features

* **api:** updates ([#894](https://github.com/openai/openai-node/issues/894)) ([b58f5a1](https://github.com/openai/openai-node/commit/b58f5a1344f631dac0fb8ecfa4fbae49af070189))

## 4.50.0 (2024-06-10)

Full Changelog: [v4.49.1...v4.50.0](https://github.com/openai/openai-node/compare/v4.49.1...v4.50.0)

### Features

* support `application/octet-stream` request bodies ([#892](https://github.com/openai/openai-node/issues/892)) ([51661c8](https://github.com/openai/openai-node/commit/51661c8068d4990df6916becb6bb85353b54ef4d))

## 4.49.1 (2024-06-07)

Full Changelog: [v4.49.0...v4.49.1](https://github.com/openai/openai-node/compare/v4.49.0...v4.49.1)

### Bug Fixes

* remove erroneous thread create argument ([#889](https://github.com/openai/openai-node/issues/889)) ([a9f898e](https://github.com/openai/openai-node/commit/a9f898ee109a0b35a672e41c6497f3a75eff7734))

## 4.49.0 (2024-06-06)

Full Changelog: [v4.48.3...v4.49.0](https://github.com/openai/openai-node/compare/v4.48.3...v4.49.0)

### Features

* **api:** updates ([#887](https://github.com/openai/openai-node/issues/887)) ([359eeb3](https://github.com/openai/openai-node/commit/359eeb33b08b371451f216d1e21dd3334ec15f36))

## 4.48.3 (2024-06-06)

Full Changelog: [v4.48.2...v4.48.3](https://github.com/openai/openai-node/compare/v4.48.2...v4.48.3)

### Chores

* **internal:** minor refactor of tests ([#884](https://github.com/openai/openai-node/issues/884)) ([0b71f2b](https://github.com/openai/openai-node/commit/0b71f2b2cb67e5714476b6f63b4ef93a0140bff2))

## 4.48.2 (2024-06-05)

Full Changelog: [v4.48.1...v4.48.2](https://github.com/openai/openai-node/compare/v4.48.1...v4.48.2)

### Chores

* **internal:** minor change to tests ([#881](https://github.com/openai/openai-node/issues/881)) ([5e2d608](https://github.com/openai/openai-node/commit/5e2d608ca9a2bcb3f261ad13c848d327b60b6fb1))

## 4.48.1 (2024-06-04)

Full Changelog: [v4.48.0...v4.48.1](https://github.com/openai/openai-node/compare/v4.48.0...v4.48.1)

### Bug Fixes

* resolve typescript issue ([1129707](https://github.com/openai/openai-node/commit/11297073b1a370fc9c8676446f939a48071999b2))

## 4.48.0 (2024-06-03)

Full Changelog: [v4.47.3...v4.48.0](https://github.com/openai/openai-node/compare/v4.47.3...v4.48.0)

### Features

* **api:** updates ([#874](https://github.com/openai/openai-node/issues/874)) ([295c248](https://github.com/openai/openai-node/commit/295c2486005f6f1eb81cbbd6994b4382801d0707))

## 4.47.3 (2024-05-31)

Full Changelog: [v4.47.2...v4.47.3](https://github.com/openai/openai-node/compare/v4.47.2...v4.47.3)

### Bug Fixes

* allow git imports for pnpm ([#873](https://github.com/openai/openai-node/issues/873)) ([9da9809](https://github.com/openai/openai-node/commit/9da98090e80cbe988a3d695e4c9b57439080ec3e))


### Documentation

* **azure:** update example and readme to use Entra ID ([#857](https://github.com/openai/openai-node/issues/857)) ([722eff1](https://github.com/openai/openai-node/commit/722eff1a7aeaa2ce3c40301709db61258c9afa16))

## 4.47.2 (2024-05-28)

Full Changelog: [v4.47.1...v4.47.2](https://github.com/openai/openai-node/compare/v4.47.1...v4.47.2)

### Documentation

* **readme:** add bundle size badge ([#869](https://github.com/openai/openai-node/issues/869)) ([e252132](https://github.com/openai/openai-node/commit/e2521327b7b4f5abe97e4c58c417b37d00079ef8))

## 4.47.1 (2024-05-14)

Full Changelog: [v4.47.0...v4.47.1](https://github.com/openai/openai-node/compare/v4.47.0...v4.47.1)

### Chores

* **internal:** add slightly better logging to scripts ([#848](https://github.com/openai/openai-node/issues/848)) ([139e690](https://github.com/openai/openai-node/commit/139e690546775b3568934dd990dd329fce2fbc2f))

## 4.47.0 (2024-05-14)

Full Changelog: [v4.46.1...v4.47.0](https://github.com/openai/openai-node/compare/v4.46.1...v4.47.0)

### Features

* **api:** add incomplete state ([#846](https://github.com/openai/openai-node/issues/846)) ([5f663a1](https://github.com/openai/openai-node/commit/5f663a167361b905c6d0c1242e8a78037a7e4a57))

## 4.46.1 (2024-05-13)

Full Changelog: [v4.46.0...v4.46.1](https://github.com/openai/openai-node/compare/v4.46.0...v4.46.1)

### Refactors

* change import paths to be relative ([#843](https://github.com/openai/openai-node/issues/843)) ([7913574](https://github.com/openai/openai-node/commit/7913574bdb6fcbcf68e56e8def351add6c43310a))

## 4.46.0 (2024-05-13)

Full Changelog: [v4.45.0...v4.46.0](https://github.com/openai/openai-node/compare/v4.45.0...v4.46.0)

### Features

* **api:** add gpt-4o model ([#841](https://github.com/openai/openai-node/issues/841)) ([c818ed1](https://github.com/openai/openai-node/commit/c818ed139bfba81af6ca3c4eda08d52366758529))

## 4.45.0 (2024-05-11)

Full Changelog: [v4.44.0...v4.45.0](https://github.com/openai/openai-node/compare/v4.44.0...v4.45.0)

### Features

* **azure:** batch api ([#839](https://github.com/openai/openai-node/issues/839)) ([e279f8c](https://github.com/openai/openai-node/commit/e279f8c51aa80cb913ccb6df647407bea1f2f071))


### Chores

* **dependency:** bumped Next.js version ([#836](https://github.com/openai/openai-node/issues/836)) ([babb140](https://github.com/openai/openai-node/commit/babb1404751059bdd171b792d03fd21272dd8f8b))
* **docs:** add SECURITY.md ([#838](https://github.com/openai/openai-node/issues/838)) ([6e556d9](https://github.com/openai/openai-node/commit/6e556d9e12341155cc13fe226ab110d63858370e))

## 4.44.0 (2024-05-09)

Full Changelog: [v4.43.0...v4.44.0](https://github.com/openai/openai-node/compare/v4.43.0...v4.44.0)

### Features

* **api:** add message image content ([#834](https://github.com/openai/openai-node/issues/834)) ([7757b3e](https://github.com/openai/openai-node/commit/7757b3ea54a2c5cc251f55af0b676952ba12e8a6))

## 4.43.0 (2024-05-08)

Full Changelog: [v4.42.0...v4.43.0](https://github.com/openai/openai-node/compare/v4.42.0...v4.43.0)

### Features

* **api:** adding file purposes ([#831](https://github.com/openai/openai-node/issues/831)) ([a62b877](https://github.com/openai/openai-node/commit/a62b8779ff7261cdd6aa7bf72fb6407cc7e3fd21))

## 4.42.0 (2024-05-06)

Full Changelog: [v4.41.1...v4.42.0](https://github.com/openai/openai-node/compare/v4.41.1...v4.42.0)

### Features

* **api:** add usage metadata when streaming ([#829](https://github.com/openai/openai-node/issues/829)) ([6707f11](https://github.com/openai/openai-node/commit/6707f119a191ad98d634ad208be852f9f39c6c0e))


### Bug Fixes

* **example:** fix fine tuning example ([#827](https://github.com/openai/openai-node/issues/827)) ([6480a50](https://github.com/openai/openai-node/commit/6480a506c096a2664bd2ad296481e51017ff4185))

## 4.41.1 (2024-05-06)

Full Changelog: [v4.41.0...v4.41.1](https://github.com/openai/openai-node/compare/v4.41.0...v4.41.1)

### Bug Fixes

* **azure:** update build script ([#825](https://github.com/openai/openai-node/issues/825)) ([8afc6e7](https://github.com/openai/openai-node/commit/8afc6e7b49507b3be0228e93913d51b4c3211add))

## 4.41.0 (2024-05-05)

Full Changelog: [v4.40.2...v4.41.0](https://github.com/openai/openai-node/compare/v4.40.2...v4.41.0)

### Features

* **client:** add Azure client ([#822](https://github.com/openai/openai-node/issues/822)) ([92f9049](https://github.com/openai/openai-node/commit/92f90499f0bbee79ba9c8342c8d58dbcaf88bdd1))

## 4.40.2 (2024-05-03)

Full Changelog: [v4.40.1...v4.40.2](https://github.com/openai/openai-node/compare/v4.40.1...v4.40.2)

### Bug Fixes

* **package:** revert recent client file change ([#819](https://github.com/openai/openai-node/issues/819)) ([fa722c9](https://github.com/openai/openai-node/commit/fa722c97859e55a0e766332c3a2f0cb3673128a2))
* **vectorStores:** correct uploadAndPoll method ([#817](https://github.com/openai/openai-node/issues/817)) ([d63f22c](https://github.com/openai/openai-node/commit/d63f22c303761710e6eac7ef883c45e34d223df1))

## 4.40.1 (2024-05-02)

Full Changelog: [v4.40.0...v4.40.1](https://github.com/openai/openai-node/compare/v4.40.0...v4.40.1)

### Chores

* **internal:** bump prism version ([#813](https://github.com/openai/openai-node/issues/813)) ([81a6c28](https://github.com/openai/openai-node/commit/81a6c28c4773a0245ce9c505fc5b98d43df21beb))
* **internal:** move client class to separate file ([#815](https://github.com/openai/openai-node/issues/815)) ([d0b915a](https://github.com/openai/openai-node/commit/d0b915a7514eda5b23d7d1e4420d1d1485ed8d0f))

## 4.40.0 (2024-05-01)

Full Changelog: [v4.39.1...v4.40.0](https://github.com/openai/openai-node/compare/v4.39.1...v4.40.0)

### Features

* **api:** delete messages ([#811](https://github.com/openai/openai-node/issues/811)) ([9e37dbd](https://github.com/openai/openai-node/commit/9e37dbd554e4ca48fda1577b1aad612e9d30534d))

## 4.39.1 (2024-04-30)

Full Changelog: [v4.39.0...v4.39.1](https://github.com/openai/openai-node/compare/v4.39.0...v4.39.1)

### Chores

* **internal:** add link to openapi spec ([#810](https://github.com/openai/openai-node/issues/810)) ([61b5b83](https://github.com/openai/openai-node/commit/61b5b83e82dd723e9584232f3b805ed13e58e13d))
* **internal:** fix release please for deno ([#808](https://github.com/openai/openai-node/issues/808)) ([ecc2eae](https://github.com/openai/openai-node/commit/ecc2eaec602eb9fe518f011920d8500e01fde01b))
* **internal:** refactor scripts ([#806](https://github.com/openai/openai-node/issues/806)) ([9283519](https://github.com/openai/openai-node/commit/928351928054feb56f8797587c70f74d06c2737c))

## 4.39.0 (2024-04-29)

Full Changelog: [v4.38.5...v4.39.0](https://github.com/openai/openai-node/compare/v4.38.5...v4.39.0)

### Features

* **api:** add required tool_choice ([#803](https://github.com/openai/openai-node/issues/803)) ([99693e6](https://github.com/openai/openai-node/commit/99693e61debc67327a45dffb2c10c113341bffd6))


### Chores

* **internal:** add scripts/test and scripts/mock ([#801](https://github.com/openai/openai-node/issues/801)) ([6656105](https://github.com/openai/openai-node/commit/6656105fa1346a91d17e2b7a5e075f3091310c2f))

## 4.38.5 (2024-04-24)

Full Changelog: [v4.38.4...v4.38.5](https://github.com/openai/openai-node/compare/v4.38.4...v4.38.5)

### Chores

* **internal:** use actions/checkout@v4 for codeflow ([#799](https://github.com/openai/openai-node/issues/799)) ([5ab7780](https://github.com/openai/openai-node/commit/5ab7780ea8889818f403a9a89ab19585a7e8972e))

## 4.38.4 (2024-04-24)

Full Changelog: [v4.38.3...v4.38.4](https://github.com/openai/openai-node/compare/v4.38.3...v4.38.4)

### Bug Fixes

* **api:** change timestamps to unix integers ([#798](https://github.com/openai/openai-node/issues/798)) ([7271a6c](https://github.com/openai/openai-node/commit/7271a6cdc7d37151d2cae18fdd20b87d97624a84))
* **docs:** doc improvements ([#796](https://github.com/openai/openai-node/issues/796)) ([49fcc86](https://github.com/openai/openai-node/commit/49fcc86b44958795a6f5e0901f369653dfbcc637))

## 4.38.3 (2024-04-22)

Full Changelog: [v4.38.2...v4.38.3](https://github.com/openai/openai-node/compare/v4.38.2...v4.38.3)

### Chores

* **internal:** use @swc/jest for running tests ([#793](https://github.com/openai/openai-node/issues/793)) ([8947f19](https://github.com/openai/openai-node/commit/8947f195b2dfab7ceebe1e0bb5c886e229cd541f))

## 4.38.2 (2024-04-19)

Full Changelog: [v4.38.1...v4.38.2](https://github.com/openai/openai-node/compare/v4.38.1...v4.38.2)

### Bug Fixes

* **api:** correct types for message attachment tools ([#787](https://github.com/openai/openai-node/issues/787)) ([8626884](https://github.com/openai/openai-node/commit/8626884abd2494aa081db9e50a2f268b6cebc5df))

## 4.38.1 (2024-04-18)

Full Changelog: [v4.38.0...v4.38.1](https://github.com/openai/openai-node/compare/v4.38.0...v4.38.1)

### Bug Fixes

* **api:** correct types for attachments ([#783](https://github.com/openai/openai-node/issues/783)) ([6893631](https://github.com/openai/openai-node/commit/6893631334f75e232ba130f5dd67f1230b1e5fa0))

## 4.38.0 (2024-04-18)

Full Changelog: [v4.37.1...v4.38.0](https://github.com/openai/openai-node/compare/v4.37.1...v4.38.0)

### Features

* **api:** batch list endpoint ([#781](https://github.com/openai/openai-node/issues/781)) ([d226759](https://github.com/openai/openai-node/commit/d226759164fbed33198d8bdc315c98e1052dade8))

## 4.37.1 (2024-04-17)

Full Changelog: [v4.37.0...v4.37.1](https://github.com/openai/openai-node/compare/v4.37.0...v4.37.1)

### Chores

* **api:** docs and response_format response property ([#778](https://github.com/openai/openai-node/issues/778)) ([78f5c35](https://github.com/openai/openai-node/commit/78f5c3568d95d8e854c04049dc7d5643aa49e93f))

## 4.37.0 (2024-04-17)

Full Changelog: [v4.36.0...v4.37.0](https://github.com/openai/openai-node/compare/v4.36.0...v4.37.0)

### Features

* **api:** add vector stores ([#776](https://github.com/openai/openai-node/issues/776)) ([8bb929b](https://github.com/openai/openai-node/commit/8bb929b2ee91c1bec0a00347bf4f7628652d1be3))

## 4.36.0 (2024-04-16)

Full Changelog: [v4.35.0...v4.36.0](https://github.com/openai/openai-node/compare/v4.35.0...v4.36.0)

### Features

* **client:** add header OpenAI-Project ([#772](https://github.com/openai/openai-node/issues/772)) ([bb4df37](https://github.com/openai/openai-node/commit/bb4df3722082fb44b7d4feb7a47df796149150a2))
* extract chat models to a named enum ([#775](https://github.com/openai/openai-node/issues/775)) ([141d2ed](https://github.com/openai/openai-node/commit/141d2ed308141dc751869353208e4d0632d3650c))


### Build System

* configure UTF-8 locale in devcontainer ([#774](https://github.com/openai/openai-node/issues/774)) ([bebf4f0](https://github.com/openai/openai-node/commit/bebf4f0ca1f884f8747caff0f0e065aafffde096))

## 4.35.0 (2024-04-15)

Full Changelog: [v4.34.0...v4.35.0](https://github.com/openai/openai-node/compare/v4.34.0...v4.35.0)

### Features

* **errors:** add request_id property ([#769](https://github.com/openai/openai-node/issues/769)) ([43aa6a1](https://github.com/openai/openai-node/commit/43aa6a19cfb1448903dfaddc4da3def2eda9cbab))

## 4.34.0 (2024-04-15)

Full Changelog: [v4.33.1...v4.34.0](https://github.com/openai/openai-node/compare/v4.33.1...v4.34.0)

### Features

* **api:** add batch API ([#768](https://github.com/openai/openai-node/issues/768)) ([7fe34f2](https://github.com/openai/openai-node/commit/7fe34f2d0bda9c1cb116a593f02bd0cc15a52e12))
* **api:** updates ([#766](https://github.com/openai/openai-node/issues/766)) ([52bcc47](https://github.com/openai/openai-node/commit/52bcc47043e4c3ffe15ae9e7ac0fa87e2493aad9))

## 4.33.1 (2024-04-12)

Full Changelog: [v4.33.0...v4.33.1](https://github.com/openai/openai-node/compare/v4.33.0...v4.33.1)

### Chores

* **internal:** formatting ([#763](https://github.com/openai/openai-node/issues/763)) ([b6acf54](https://github.com/openai/openai-node/commit/b6acf54baab7e6cbf6ce3ad1d6c70197cc0181d0))
* **internal:** improve ecosystem tests ([#761](https://github.com/openai/openai-node/issues/761)) ([fcf748d](https://github.com/openai/openai-node/commit/fcf748dbbd23f972ff9fd81a8b2a35232a2d6e5c))

## 4.33.0 (2024-04-05)

Full Changelog: [v4.32.2...v4.33.0](https://github.com/openai/openai-node/compare/v4.32.2...v4.33.0)

### Features

* **api:** add additional messages when creating thread run ([#759](https://github.com/openai/openai-node/issues/759)) ([f1fdb41](https://github.com/openai/openai-node/commit/f1fdb410e087f9b94faeda0558de573ec1118601))

## 4.32.2 (2024-04-04)

Full Changelog: [v4.32.1...v4.32.2](https://github.com/openai/openai-node/compare/v4.32.1...v4.32.2)

### Bug Fixes

* **streaming:** handle special line characters and fix multi-byte character decoding ([#757](https://github.com/openai/openai-node/issues/757)) ([8dcdda2](https://github.com/openai/openai-node/commit/8dcdda2b0d1d86486eea5fd47d24a8d26fde4c19))
* **tests:** update wrangler to v3.19.0 (CVE-2023-7080) ([#755](https://github.com/openai/openai-node/issues/755)) ([47ca41d](https://github.com/openai/openai-node/commit/47ca41da9a739b2e04b721cb1fe843e5dd152465))


### Chores

* **tests:** bump ecosystem tests dependencies ([#753](https://github.com/openai/openai-node/issues/753)) ([3f86ea2](https://github.com/openai/openai-node/commit/3f86ea2205c90e05bcbe582491a4bed01075a5b1))

## 4.32.1 (2024-04-02)

Full Changelog: [v4.32.0...v4.32.1](https://github.com/openai/openai-node/compare/v4.32.0...v4.32.1)

### Chores

* **deps:** bump yarn to v1.22.22 ([#751](https://github.com/openai/openai-node/issues/751)) ([5b41d10](https://github.com/openai/openai-node/commit/5b41d1077f219b8feb7557cfab98caf7b5de560d))

## 4.32.0 (2024-04-01)

Full Changelog: [v4.31.0...v4.32.0](https://github.com/openai/openai-node/compare/v4.31.0...v4.32.0)

### Features

* **api:** add support for filtering messages by run_id ([#747](https://github.com/openai/openai-node/issues/747)) ([9a397ac](https://github.com/openai/openai-node/commit/9a397acffa9f10c3f48e86e3bdb3851770f87b42))
* **api:** run polling helpers ([#749](https://github.com/openai/openai-node/issues/749)) ([02920ae](https://github.com/openai/openai-node/commit/02920ae082480fc7a7ffe9fa583d053a40dc7120))


### Chores

* **deps:** remove unused dependency digest-fetch ([#748](https://github.com/openai/openai-node/issues/748)) ([5376837](https://github.com/openai/openai-node/commit/537683734d39dd956a7dcef4339c1167ce6fe13c))


### Documentation

* **readme:** change undocumented params wording ([#744](https://github.com/openai/openai-node/issues/744)) ([8796691](https://github.com/openai/openai-node/commit/87966911045275db86844dfdcde59653edaef264))


### Refactors

* rename createAndStream to stream ([02920ae](https://github.com/openai/openai-node/commit/02920ae082480fc7a7ffe9fa583d053a40dc7120))

## 4.31.0 (2024-03-30)

Full Changelog: [v4.30.0...v4.31.0](https://github.com/openai/openai-node/compare/v4.30.0...v4.31.0)

### Features

* **api:** adding temperature parameter ([#742](https://github.com/openai/openai-node/issues/742)) ([b173b05](https://github.com/openai/openai-node/commit/b173b05eb52266d8f2c835ec4ed71cba8cdc609b))


### Bug Fixes

* **streaming:** trigger all event handlers with fromReadableStream ([#741](https://github.com/openai/openai-node/issues/741)) ([7b1e593](https://github.com/openai/openai-node/commit/7b1e5937d97b309ed51928b4388dcde74abda8dc))

## 4.30.0 (2024-03-28)

Full Changelog: [v4.29.2...v4.30.0](https://github.com/openai/openai-node/compare/v4.29.2...v4.30.0)

### Features

* assistant fromReadableStream ([#738](https://github.com/openai/openai-node/issues/738)) ([8f4ba18](https://github.com/openai/openai-node/commit/8f4ba18268797d6c54c393d701b13c7ff2aa71bc))


### Bug Fixes

* **client:** correctly send deno version header ([#736](https://github.com/openai/openai-node/issues/736)) ([b7ea175](https://github.com/openai/openai-node/commit/b7ea175b2854909de77b920dd25613f1d2daefd6))
* **example:** correcting example ([#739](https://github.com/openai/openai-node/issues/739)) ([a819551](https://github.com/openai/openai-node/commit/a81955175da24e196490a38850bbf6f9b6779ea8))
* handle process.env being undefined in debug func ([#733](https://github.com/openai/openai-node/issues/733)) ([2baa149](https://github.com/openai/openai-node/commit/2baa1491f7834f779ca49c3027d2344ead412dd2))
* **internal:** make toFile use input file's options ([#727](https://github.com/openai/openai-node/issues/727)) ([15880d7](https://github.com/openai/openai-node/commit/15880d77b6c1cf58a6b9cfdbf7ae4442cdbddbd6))


### Chores

* **internal:** add type ([#737](https://github.com/openai/openai-node/issues/737)) ([18c1989](https://github.com/openai/openai-node/commit/18c19891f783019517d7961fe03c4d98de0fcf93))


### Documentation

* **readme:** consistent use of sentence case in headings ([#729](https://github.com/openai/openai-node/issues/729)) ([7e515fd](https://github.com/openai/openai-node/commit/7e515fde433ebfb7871d75d53915eef05a08a916))
* **readme:** document how to make undocumented requests ([#730](https://github.com/openai/openai-node/issues/730)) ([a06d861](https://github.com/openai/openai-node/commit/a06d861a015eeee411fa2c6ed9bf3000313cfc03))

## 4.29.2 (2024-03-19)

Full Changelog: [v4.29.1...v4.29.2](https://github.com/openai/openai-node/compare/v4.29.1...v4.29.2)

### Chores

* **internal:** update generated pragma comment ([#724](https://github.com/openai/openai-node/issues/724)) ([139e205](https://github.com/openai/openai-node/commit/139e205ed1ed30cb1df982d852a093dcea945aba))


### Documentation

* assistant improvements ([#725](https://github.com/openai/openai-node/issues/725)) ([6a2c41b](https://github.com/openai/openai-node/commit/6a2c41b0ce833eba0cdea6a7d221697f3be26abb))
* fix typo in CONTRIBUTING.md ([#722](https://github.com/openai/openai-node/issues/722)) ([05ff8f7](https://github.com/openai/openai-node/commit/05ff8f7671fe6ce5d9517034f76a166a0bd27803))

## 4.29.1 (2024-03-15)

Full Changelog: [v4.29.0...v4.29.1](https://github.com/openai/openai-node/compare/v4.29.0...v4.29.1)

### Documentation

* **readme:** assistant streaming ([#719](https://github.com/openai/openai-node/issues/719)) ([bc9a1ca](https://github.com/openai/openai-node/commit/bc9a1ca308020a88c29d409edc06cdfca8cbf8f5))

## 4.29.0 (2024-03-13)

Full Changelog: [v4.28.5...v4.29.0](https://github.com/openai/openai-node/compare/v4.28.5...v4.29.0)

### Features

* **assistants:** add support for streaming ([#714](https://github.com/openai/openai-node/issues/714)) ([7d27d28](https://github.com/openai/openai-node/commit/7d27d286876d0a575d91a4752f401126fe93d2a3))

## 4.28.5 (2024-03-13)

Full Changelog: [v4.28.4...v4.28.5](https://github.com/openai/openai-node/compare/v4.28.4...v4.28.5)

### Bug Fixes

* **ChatCompletionStream:** abort on async iterator break and handle errors ([#699](https://github.com/openai/openai-node/issues/699)) ([ac417a2](https://github.com/openai/openai-node/commit/ac417a2db31919d2b52f2eb2e38f9c67a8f73254))
* **streaming:** correctly handle trailing new lines in byte chunks ([#708](https://github.com/openai/openai-node/issues/708)) ([4753be2](https://github.com/openai/openai-node/commit/4753be272b1d1dade7a769cf350b829fc639f36e))


### Chores

* **api:** update docs ([#703](https://github.com/openai/openai-node/issues/703)) ([e1db98b](https://github.com/openai/openai-node/commit/e1db98bef29d200e2e401e3f5d7b2db6839c7836))
* **docs:** mention install from git repo ([#700](https://github.com/openai/openai-node/issues/700)) ([c081bdb](https://github.com/openai/openai-node/commit/c081bdbb55585e63370496d324dc6f94d86424d1))
* fix error handler in readme ([#704](https://github.com/openai/openai-node/issues/704)) ([4ff790a](https://github.com/openai/openai-node/commit/4ff790a67cf876191e04ad0e369e447e080b78a7))
* **internal:** add explicit type annotation to decoder ([#712](https://github.com/openai/openai-node/issues/712)) ([d728e99](https://github.com/openai/openai-node/commit/d728e9923554e4c72c9efa3bd528561400d50ad8))
* **types:** fix accidental exposure of Buffer type to cloudflare ([#709](https://github.com/openai/openai-node/issues/709)) ([0323ecb](https://github.com/openai/openai-node/commit/0323ecb98ddbd8910fc5719c8bab5175b945d2ab))


### Documentation

* **contributing:** improve wording ([#696](https://github.com/openai/openai-node/issues/696)) ([940d569](https://github.com/openai/openai-node/commit/940d5695f4cacddbb58e3bfc50fec28c468c7e63))
* **readme:** fix https proxy example ([#705](https://github.com/openai/openai-node/issues/705)) ([d144789](https://github.com/openai/openai-node/commit/d1447890a556d37928b628f6449bb80de224d207))
* **readme:** fix typo in custom fetch implementation ([#698](https://github.com/openai/openai-node/issues/698)) ([64041fd](https://github.com/openai/openai-node/commit/64041fd33da569eccae64afe4e50ee803017b20b))
* remove extraneous --save and yarn install instructions ([#710](https://github.com/openai/openai-node/issues/710)) ([8ec216d](https://github.com/openai/openai-node/commit/8ec216d6b72ee4d67e26786f06c93af18d042117))
* use [@deprecated](https://github.com/deprecated) decorator for deprecated params ([#711](https://github.com/openai/openai-node/issues/711)) ([4688ef4](https://github.com/openai/openai-node/commit/4688ef4b36e9f383a3abf6cdb31d498163a7bb9e))

## 4.28.4 (2024-02-28)

Full Changelog: [v4.28.3...v4.28.4](https://github.com/openai/openai-node/compare/v4.28.3...v4.28.4)

### Features

* **api:** add wav and pcm to response_format ([#691](https://github.com/openai/openai-node/issues/691)) ([b1c6171](https://github.com/openai/openai-node/commit/b1c61711961a62a4d7b47909a68ecd65231a66af))


### Chores

* **ci:** update actions/setup-node action to v4 ([#685](https://github.com/openai/openai-node/issues/685)) ([f2704d5](https://github.com/openai/openai-node/commit/f2704d5f1580c0f1d31584ef88702cde8f6804d4))
* **internal:** fix ecosystem tests ([#693](https://github.com/openai/openai-node/issues/693)) ([616624d](https://github.com/openai/openai-node/commit/616624d3d9fd10ce254ce0d435b2b73ed11679f2))
* **types:** extract run status to a named type ([#686](https://github.com/openai/openai-node/issues/686)) ([b3b3b8e](https://github.com/openai/openai-node/commit/b3b3b8ea20e0f311d3bd53dfd22ccc04f5dce5f7))
* update @types/react to 18.2.58, @types/react-dom to 18.2.19 ([#688](https://github.com/openai/openai-node/issues/688)) ([2a0d0b1](https://github.com/openai/openai-node/commit/2a0d0b1cb197eef25e42bbba88ee90c37d623f24))
* update dependency @types/node to v20.11.20 ([#690](https://github.com/openai/openai-node/issues/690)) ([4ca005b](https://github.com/openai/openai-node/commit/4ca005be082d6c50fe95da6148896b62080bfe07))
* update dependency @types/ws to v8.5.10 ([#683](https://github.com/openai/openai-node/issues/683)) ([a617268](https://github.com/openai/openai-node/commit/a6172683a3390422984ad282ac4940781493e772))
* update dependency next to v13.5.6 ([#689](https://github.com/openai/openai-node/issues/689)) ([abb3b66](https://github.com/openai/openai-node/commit/abb3b6674b8f9f8ff9c2cc61629a31883ae4d8c8))

## 4.28.3 (2024-02-20)

Full Changelog: [v4.28.2...v4.28.3](https://github.com/openai/openai-node/compare/v4.28.2...v4.28.3)

### Bug Fixes

* **ci:** revert "move github release logic to github app" ([#680](https://github.com/openai/openai-node/issues/680)) ([8b4009a](https://github.com/openai/openai-node/commit/8b4009af05a2e0824f99d3cf8cd9063f234ae470))

## 4.28.2 (2024-02-19)

Full Changelog: [v4.28.1...v4.28.2](https://github.com/openai/openai-node/compare/v4.28.1...v4.28.2)

### Bug Fixes

* **api:** remove non-GA instance_id param ([#677](https://github.com/openai/openai-node/issues/677)) ([4d0d4da](https://github.com/openai/openai-node/commit/4d0d4daf3bfca0089c5258a136542513e6b372e6))

## 4.28.1 (2024-02-19)

Full Changelog: [v4.28.0...v4.28.1](https://github.com/openai/openai-node/compare/v4.28.0...v4.28.1)

### Chores

* **ci:** move github release logic to github app ([#671](https://github.com/openai/openai-node/issues/671)) ([ecca6bc](https://github.com/openai/openai-node/commit/ecca6bc2eea391ee53f1a1d6cac9665199447ae0))
* **internal:** refactor release environment script ([#674](https://github.com/openai/openai-node/issues/674)) ([27d3770](https://github.com/openai/openai-node/commit/27d37705d17e05c3761ccefcf09c4e2018eb5772))

## 4.28.0 (2024-02-13)

Full Changelog: [v4.27.1...v4.28.0](https://github.com/openai/openai-node/compare/v4.27.1...v4.28.0)

### Features

* **api:** updates ([#669](https://github.com/openai/openai-node/issues/669)) ([e1900f9](https://github.com/openai/openai-node/commit/e1900f97ee3f4758d47a7eb4659e30abe3750c99))

## 4.27.1 (2024-02-12)

Full Changelog: [v4.27.0...v4.27.1](https://github.com/openai/openai-node/compare/v4.27.0...v4.27.1)

## 4.27.0 (2024-02-08)

Full Changelog: [v4.26.1...v4.27.0](https://github.com/openai/openai-node/compare/v4.26.1...v4.27.0)

### Features

* **api:** add `timestamp_granularities`, add `gpt-3.5-turbo-0125` model ([#661](https://github.com/openai/openai-node/issues/661)) ([5016806](https://github.com/openai/openai-node/commit/50168066862f66b529bae29f4564741300303246))


### Chores

* **internal:** fix retry mechanism for ecosystem-test ([#663](https://github.com/openai/openai-node/issues/663)) ([0eb7ed5](https://github.com/openai/openai-node/commit/0eb7ed5ca3f7c7b29c316fc7d725d834cee73989))
* respect `application/vnd.api+json` content-type header ([#664](https://github.com/openai/openai-node/issues/664)) ([f4fad54](https://github.com/openai/openai-node/commit/f4fad549c5c366d8dd8b936b7699639b895e82a1))

## 4.26.1 (2024-02-05)

Full Changelog: [v4.26.0...v4.26.1](https://github.com/openai/openai-node/compare/v4.26.0...v4.26.1)

### Chores

* **internal:** enable building when git installed ([#657](https://github.com/openai/openai-node/issues/657)) ([8c80a7d](https://github.com/openai/openai-node/commit/8c80a7d6d36155901a19d1f9cd1fec17b89e261e))
* **internal:** re-order pagination import ([#656](https://github.com/openai/openai-node/issues/656)) ([21ae54e](https://github.com/openai/openai-node/commit/21ae54ea2cc2779e440909782a6ac8b70f88ec1f))
* **internal:** support pre-release versioning ([#653](https://github.com/openai/openai-node/issues/653)) ([0c3859f](https://github.com/openai/openai-node/commit/0c3859f88164ae3eb6ec8c29e8889a50861cb35b))
* **test:** add delay between ecosystem tests retry ([#651](https://github.com/openai/openai-node/issues/651)) ([6a4cc5c](https://github.com/openai/openai-node/commit/6a4cc5cea36ae408c8c1eb2ea0ea02f96ffb77b7))


### Documentation

* add a CONTRIBUTING.md ([#659](https://github.com/openai/openai-node/issues/659)) ([8ea58b0](https://github.com/openai/openai-node/commit/8ea58b0b9e7382a3b3af852a9a3a288a485ad33a))

## 4.26.0 (2024-01-25)

Full Changelog: [v4.25.0...v4.26.0](https://github.com/openai/openai-node/compare/v4.25.0...v4.26.0)

### Features

* **api:** add text embeddings dimensions param ([#650](https://github.com/openai/openai-node/issues/650)) ([1b5a977](https://github.com/openai/openai-node/commit/1b5a977d0eef7f5cf97daf27333cbbeb6bb479f3))


### Chores

* **internal:** add internal helpers & improve build scripts ([#643](https://github.com/openai/openai-node/issues/643)) ([9392f50](https://github.com/openai/openai-node/commit/9392f50e47f26b16632c9eb12187ea7f8a565e09))
* **internal:** adjust ecosystem-tests logging in CI ([#646](https://github.com/openai/openai-node/issues/646)) ([156084b](https://github.com/openai/openai-node/commit/156084b8734194a5856612378115b948c82ec6e4))
* **internal:** don't re-export streaming type ([#648](https://github.com/openai/openai-node/issues/648)) ([4c4be94](https://github.com/openai/openai-node/commit/4c4be945fa3f54036183e2d0877060db47ea564b))
* **internal:** fix binary files ([#645](https://github.com/openai/openai-node/issues/645)) ([e1fbc39](https://github.com/openai/openai-node/commit/e1fbc396f4d1dd8ba980c25ba03b670dfed887a0))
* **internal:** minor streaming updates ([#647](https://github.com/openai/openai-node/issues/647)) ([2f073e4](https://github.com/openai/openai-node/commit/2f073e4e6c9cd0ff3ad434907da710704765a005))
* **internal:** pin deno version ([#649](https://github.com/openai/openai-node/issues/649)) ([7e4b903](https://github.com/openai/openai-node/commit/7e4b9039320e4ccbafb45f57dce273bedc9b7cb3))

## 4.25.0 (2024-01-21)

Full Changelog: [v4.24.7...v4.25.0](https://github.com/openai/openai-node/compare/v4.24.7...v4.25.0)

### Features

* **api:** add usage to runs and run steps ([#640](https://github.com/openai/openai-node/issues/640)) ([3caa416](https://github.com/openai/openai-node/commit/3caa4166b8abb5bffb4c8be1495834b7f16af32d))


### Bug Fixes

* allow body type in RequestOptions to be null ([#637](https://github.com/openai/openai-node/issues/637)) ([c4f8a36](https://github.com/openai/openai-node/commit/c4f8a3698dc1d80439131c5097975d6a5db1b4e2))
* handle system_fingerprint in streaming helpers ([#636](https://github.com/openai/openai-node/issues/636)) ([f273530](https://github.com/openai/openai-node/commit/f273530ac491300842aef463852821a1a27805fb))
* **types:** accept undefined for optional client options ([#635](https://github.com/openai/openai-node/issues/635)) ([e48cd57](https://github.com/openai/openai-node/commit/e48cd57931cd0e81a77b55653cb1f663111dd733))


### Chores

* **internal:** debug logging for retries; speculative retry-after-ms support ([#633](https://github.com/openai/openai-node/issues/633)) ([fd64971](https://github.com/openai/openai-node/commit/fd64971612d1d7fcbd8a63885d333485bff68ab1))
* **internal:** update comment ([#631](https://github.com/openai/openai-node/issues/631)) ([e109d40](https://github.com/openai/openai-node/commit/e109d40a5c02c5bf4586e54d92bf0e355d254c1b))

## 4.24.7 (2024-01-13)

Full Changelog: [v4.24.6...v4.24.7](https://github.com/openai/openai-node/compare/v4.24.6...v4.24.7)

### Chores

* **ecosystem-tests:** fix flaky vercel-edge, cloudflare-worker, and deno tests ([#626](https://github.com/openai/openai-node/issues/626)) ([ae412a5](https://github.com/openai/openai-node/commit/ae412a5f12e701e07e71bd9791c55a56858e8383))
* **ecosystem-tests:** fix typo in deno test ([#628](https://github.com/openai/openai-node/issues/628)) ([048ec94](https://github.com/openai/openai-node/commit/048ec943f8d12acba9829c35ebf0b2d3f24930c8))

## 4.24.6 (2024-01-12)

Full Changelog: [v4.24.5...v4.24.6](https://github.com/openai/openai-node/compare/v4.24.5...v4.24.6)

### Chores

* **ecosystem-tests:** fix flaky tests and remove fine tuning calls ([#623](https://github.com/openai/openai-node/issues/623)) ([258d79f](https://github.com/openai/openai-node/commit/258d79f52bb31f4f3723f6f4b97ebe8f3fa187bd))
* **ecosystem-tests:** fix flaky tests and remove fine tuning calls ([#625](https://github.com/openai/openai-node/issues/625)) ([58e5fd8](https://github.com/openai/openai-node/commit/58e5fd8f27052be6ac9587256b161f4bf3a3805f))

## 4.24.5 (2024-01-12)

Full Changelog: [v4.24.4...v4.24.5](https://github.com/openai/openai-node/compare/v4.24.4...v4.24.5)

### Refactors

* **api:** remove deprecated endpoints ([#621](https://github.com/openai/openai-node/issues/621)) ([2054d71](https://github.com/openai/openai-node/commit/2054d71e6b0d407229a4c5aecd75e38c336c2c02))

## 4.24.4 (2024-01-11)

Full Changelog: [v4.24.3...v4.24.4](https://github.com/openai/openai-node/compare/v4.24.3...v4.24.4)

### Chores

* **internal:** narrow type into stringifyQuery ([#619](https://github.com/openai/openai-node/issues/619)) ([88fb9cd](https://github.com/openai/openai-node/commit/88fb9cd1bb415850b0b4868944617282d0b92e2a))

## 4.24.3 (2024-01-10)

Full Changelog: [v4.24.2...v4.24.3](https://github.com/openai/openai-node/compare/v4.24.2...v4.24.3)

### Bug Fixes

* use default base url if BASE_URL env var is blank ([#615](https://github.com/openai/openai-node/issues/615)) ([a27ad3d](https://github.com/openai/openai-node/commit/a27ad3d4e06f2202daa169668d0e7d89e87a38a7))

## 4.24.2 (2024-01-08)

Full Changelog: [v4.24.1...v4.24.2](https://github.com/openai/openai-node/compare/v4.24.1...v4.24.2)

### Bug Fixes

* **headers:** always send lowercase headers and strip undefined (BREAKING in rare cases) ([#608](https://github.com/openai/openai-node/issues/608)) ([4ea159f](https://github.com/openai/openai-node/commit/4ea159f0aa9a1f4c365c74ee726714fe692ddf9f))


### Chores

* add .keep files for examples and custom code directories ([#612](https://github.com/openai/openai-node/issues/612)) ([5e0f733](https://github.com/openai/openai-node/commit/5e0f733d3cd3c8e6d41659141168cd0708e017a3))
* **internal:** bump license ([#605](https://github.com/openai/openai-node/issues/605)) ([045ee74](https://github.com/openai/openai-node/commit/045ee74fd3ffba9e6d1301fe1ffd8bd3c63720a2))
* **internal:** improve type signatures ([#609](https://github.com/openai/openai-node/issues/609)) ([e1ccc82](https://github.com/openai/openai-node/commit/e1ccc82e4991262a631dcffa4d09bdc553e50fbb))


### Documentation

* fix docstring typos ([#600](https://github.com/openai/openai-node/issues/600)) ([1934fa1](https://github.com/openai/openai-node/commit/1934fa15f654ea89e226457f76febe6015616f6c))
* improve audio example to show how to stream to a file ([#598](https://github.com/openai/openai-node/issues/598)) ([e950ad9](https://github.com/openai/openai-node/commit/e950ad969e845d608ed71bd3e3095cd6c941d93d))

## 4.24.1 (2023-12-22)

Full Changelog: [v4.24.0...v4.24.1](https://github.com/openai/openai-node/compare/v4.24.0...v4.24.1)

### Bug Fixes

* **pagination:** correct type annotation object field ([#590](https://github.com/openai/openai-node/issues/590)) ([4066eda](https://github.com/openai/openai-node/commit/4066edad4b5305e82e610f44f4720843f2b69d39))


### Documentation

* **messages:** improvements to helpers reference + typos ([#595](https://github.com/openai/openai-node/issues/595)) ([96a59b9](https://github.com/openai/openai-node/commit/96a59b91c424db67b8a5bdb7cab5da68c57282d4))
* reformat README.md ([#592](https://github.com/openai/openai-node/issues/592)) ([8ffc7f8](https://github.com/openai/openai-node/commit/8ffc7f876cc8f4b7afaf68a37f94f826ef22a6b8))


### Refactors

* write jest config in typescript ([#588](https://github.com/openai/openai-node/issues/588)) ([eb6ceeb](https://github.com/openai/openai-node/commit/eb6ceebf90ba45ec5b803f32b9b080829f6a973a))

## 4.24.0 (2023-12-19)

Full Changelog: [v4.23.0...v4.24.0](https://github.com/openai/openai-node/compare/v4.23.0...v4.24.0)

### Features

* **api:** add additional instructions for runs ([#586](https://github.com/openai/openai-node/issues/586)) ([401d93e](https://github.com/openai/openai-node/commit/401d93ea39fe0e90088799858299322035c0a7e8))


### Chores

* **deps:** update dependency start-server-and-test to v2.0.3 ([#580](https://github.com/openai/openai-node/issues/580)) ([8e1aca1](https://github.com/openai/openai-node/commit/8e1aca1f8be6e583483919ed9ef9b04fab076066))
* **deps:** update dependency ts-jest to v29.1.1 ([#578](https://github.com/openai/openai-node/issues/578)) ([a6edb7b](https://github.com/openai/openai-node/commit/a6edb7bc3cfc447d0c55ae23cc1c2219105d3666))
* **deps:** update jest ([#582](https://github.com/openai/openai-node/issues/582)) ([e49e471](https://github.com/openai/openai-node/commit/e49e471ec7a136f2cbaf82551ccaaea366c87a91))
* **internal:** bump deps ([#583](https://github.com/openai/openai-node/issues/583)) ([2e07b4c](https://github.com/openai/openai-node/commit/2e07b4c66ab1fdbb353fdd00994e293f93e981db))
* **internal:** update deps ([#581](https://github.com/openai/openai-node/issues/581)) ([7b690dc](https://github.com/openai/openai-node/commit/7b690dca67ee8c3b0a89caf7f786ede5dc612a76))


### Documentation

* upgrade models in examples to latest version ([#585](https://github.com/openai/openai-node/issues/585)) ([60101a4](https://github.com/openai/openai-node/commit/60101a4117b1a8223d09fb9fe21d89af32431939))

## 4.23.0 (2023-12-17)

Full Changelog: [v4.22.1...v4.23.0](https://github.com/openai/openai-node/compare/v4.22.1...v4.23.0)

### Features

* **api:** add token logprobs to chat completions ([#576](https://github.com/openai/openai-node/issues/576)) ([8d4292e](https://github.com/openai/openai-node/commit/8d4292e6358920b2c9d8df49c6a154231c468512))


### Chores

* **ci:** run release workflow once per day ([#574](https://github.com/openai/openai-node/issues/574)) ([529f09f](https://github.com/openai/openai-node/commit/529f09f827a675d6e851590acff4e6f4f2af2d26))

## 4.22.1 (2023-12-15)

Full Changelog: [v4.22.0...v4.22.1](https://github.com/openai/openai-node/compare/v4.22.0...v4.22.1)

### Chores

* update dependencies ([#572](https://github.com/openai/openai-node/issues/572)) ([a51e620](https://github.com/openai/openai-node/commit/a51e62065224a516b17dd850ae564f5436d8db52))


### Documentation

* replace runFunctions with runTools in readme ([#570](https://github.com/openai/openai-node/issues/570)) ([c3b9ad5](https://github.com/openai/openai-node/commit/c3b9ad58e5f74d3339889aeb1d758c8c18f54de7))

## 4.22.0 (2023-12-15)

Full Changelog: [v4.21.0...v4.22.0](https://github.com/openai/openai-node/compare/v4.21.0...v4.22.0)

### Features

* **api:** add optional `name` argument + improve docs ([#569](https://github.com/openai/openai-node/issues/569)) ([3b68ace](https://github.com/openai/openai-node/commit/3b68ace533976aedbf642d9b018d0de8d9a8bb88))


### Chores

* update prettier ([#567](https://github.com/openai/openai-node/issues/567)) ([83dec2a](https://github.com/openai/openai-node/commit/83dec2af62c481d7de16d8a3644aa239ded9e30c))

## 4.21.0 (2023-12-11)

Full Changelog: [v4.20.1...v4.21.0](https://github.com/openai/openai-node/compare/v4.20.1...v4.21.0)

### Features

* **client:** support reading the base url from an env variable ([#547](https://github.com/openai/openai-node/issues/547)) ([06fb68d](https://github.com/openai/openai-node/commit/06fb68de1ff80983e349b6715d1037e2072c8dd4))


### Bug Fixes

* correct some runTools behavior and deprecate runFunctions ([#562](https://github.com/openai/openai-node/issues/562)) ([f5cdd0f](https://github.com/openai/openai-node/commit/f5cdd0f704d3d075cdfc5bc2df1f7a8bae5cd9f1))
* prevent 400 when using runTools/runFunctions with Azure OpenAI API ([#544](https://github.com/openai/openai-node/issues/544)) ([735d9b8](https://github.com/openai/openai-node/commit/735d9b86acdc067e1ee6ebe1ea50de2955431050))


### Documentation

* **readme:** update example snippets ([#546](https://github.com/openai/openai-node/issues/546)) ([566d290](https://github.com/openai/openai-node/commit/566d290006920f536788bb77f4d24a6906e2971f))


### Build System

* specify `packageManager: yarn` ([#561](https://github.com/openai/openai-node/issues/561)) ([935b898](https://github.com/openai/openai-node/commit/935b8983c74f7b03b67d22f4d194989838f963f3))

## 4.20.1 (2023-11-24)

Full Changelog: [v4.20.0...v4.20.1](https://github.com/openai/openai-node/compare/v4.20.0...v4.20.1)

### Chores

* **internal:** remove file import and conditionally run prepare ([#533](https://github.com/openai/openai-node/issues/533)) ([48cb729](https://github.com/openai/openai-node/commit/48cb729bfc484ce3d04273be417b307a0d20644f))


### Documentation

* **readme:** fix typo and add examples link ([#529](https://github.com/openai/openai-node/issues/529)) ([cf959b1](https://github.com/openai/openai-node/commit/cf959b17db0a4f8dd7eb59add333c4a461b02459))

## 4.20.0 (2023-11-22)

Full Changelog: [v4.19.1...v4.20.0](https://github.com/openai/openai-node/compare/v4.19.1...v4.20.0)

### Features

* allow installing package directly from github ([#522](https://github.com/openai/openai-node/issues/522)) ([51926d7](https://github.com/openai/openai-node/commit/51926d7a0092744e49de39f4988feddf313adafa))


### Chores

* **internal:** don't call prepare in dist ([#525](https://github.com/openai/openai-node/issues/525)) ([d09411e](https://github.com/openai/openai-node/commit/d09411ebaa28d6610e1b880d03339d520b4a1833))

## 4.19.1 (2023-11-20)

Full Changelog: [v4.19.0...v4.19.1](https://github.com/openai/openai-node/compare/v4.19.0...v4.19.1)

## 4.19.0 (2023-11-15)

Full Changelog: [v4.18.0...v4.19.0](https://github.com/openai/openai-node/compare/v4.18.0...v4.19.0)

### Features

* **api:** updates ([#501](https://github.com/openai/openai-node/issues/501)) ([944d58e](https://github.com/openai/openai-node/commit/944d58e5fc46f1a0671aaa2b809d28e67edf6023))

## 4.18.0 (2023-11-14)

Full Changelog: [v4.17.5...v4.18.0](https://github.com/openai/openai-node/compare/v4.17.5...v4.18.0)

### Features

* **api:** add gpt-3.5-turbo-1106 ([#496](https://github.com/openai/openai-node/issues/496)) ([45f7672](https://github.com/openai/openai-node/commit/45f7672ccf4856ac309b08c6c96f0e73ab48b525))

## 4.17.5 (2023-11-13)

Full Changelog: [v4.17.4...v4.17.5](https://github.com/openai/openai-node/compare/v4.17.4...v4.17.5)

### Chores

* fix typo in docs and add request header for function calls ([#494](https://github.com/openai/openai-node/issues/494)) ([22ce244](https://github.com/openai/openai-node/commit/22ce2443a77f10988b3215bd81ba17d4eda4b10e))

## 4.17.4 (2023-11-10)

Full Changelog: [v4.17.3...v4.17.4](https://github.com/openai/openai-node/compare/v4.17.3...v4.17.4)

### Chores

* **internal:** update jest config ([#482](https://github.com/openai/openai-node/issues/482)) ([3013e8c](https://github.com/openai/openai-node/commit/3013e8c73a61a397a418ca75b996f0a7dd03a744))

## 4.17.3 (2023-11-09)

Full Changelog: [v4.17.2...v4.17.3](https://github.com/openai/openai-node/compare/v4.17.2...v4.17.3)

## 4.17.2 (2023-11-09)

Full Changelog: [v4.17.1...v4.17.2](https://github.com/openai/openai-node/compare/v4.17.1...v4.17.2)

### Chores

* **internal:** bump deno version number ([#478](https://github.com/openai/openai-node/issues/478)) ([69913f3](https://github.com/openai/openai-node/commit/69913f3a4b0123394029759375445dae7b4f15ab))

## 4.17.1 (2023-11-09)

Full Changelog: [v4.17.0...v4.17.1](https://github.com/openai/openai-node/compare/v4.17.0...v4.17.1)

### Refactors

* **client:** deprecate files.retrieveContent in favour of files.content ([#474](https://github.com/openai/openai-node/issues/474)) ([7c7bfc2](https://github.com/openai/openai-node/commit/7c7bfc2fad5a786c9172110e90c9566a943e49f9))

## 4.17.0 (2023-11-08)

Full Changelog: [v4.16.2...v4.17.0](https://github.com/openai/openai-node/compare/v4.16.2...v4.17.0)

### Features

* **api:** unify function types ([#467](https://github.com/openai/openai-node/issues/467)) ([d51cd94](https://github.com/openai/openai-node/commit/d51cd94b3103219789447e2e9afc4762ae672e5a))


### Refactors

* **api:** rename FunctionObject to FunctionDefinition ([#470](https://github.com/openai/openai-node/issues/470)) ([f3990c7](https://github.com/openai/openai-node/commit/f3990c779e596309b62f41d7a1253d8629aca3bf))

## 4.16.2 (2023-11-08)

Full Changelog: [v4.16.1...v4.16.2](https://github.com/openai/openai-node/compare/v4.16.1...v4.16.2)

### Bug Fixes

* **api:** accidentally required params, add new models & other fixes ([#463](https://github.com/openai/openai-node/issues/463)) ([1cb403e](https://github.com/openai/openai-node/commit/1cb403e4ccde61bb1613d362f6bdbca8b1681e00))
* **api:** update embedding response object type ([#466](https://github.com/openai/openai-node/issues/466)) ([53b7e25](https://github.com/openai/openai-node/commit/53b7e2539cca0b272be96136c123d2b33745e7f6))
* asssitant_deleted -&gt; assistant_deleted ([#452](https://github.com/openai/openai-node/issues/452)) ([ef89bd7](https://github.com/openai/openai-node/commit/ef89bd74d85c833bf7de500eecd1b092a0ad3f37))
* **types:** ensure all code paths return a value ([#458](https://github.com/openai/openai-node/issues/458)) ([19402c3](https://github.com/openai/openai-node/commit/19402c365572a99cbee58bcd34a9942e741269bf))


### Chores

* **docs:** fix github links ([#457](https://github.com/openai/openai-node/issues/457)) ([6b9b94e](https://github.com/openai/openai-node/commit/6b9b94e4e123349a908b708cd574ff107f40a8e1))
* **internal:** fix typo in comment ([#456](https://github.com/openai/openai-node/issues/456)) ([fe24342](https://github.com/openai/openai-node/commit/fe2434284a91d424510873a18079b8870469c672))


### Documentation

* update deno deploy link to include v ([#441](https://github.com/openai/openai-node/issues/441)) ([47b13aa](https://github.com/openai/openai-node/commit/47b13aaa6fac86fffabee1f752ee6d2efc3def9b))

## 4.16.1 (2023-11-06)

Full Changelog: [v4.16.0...v4.16.1](https://github.com/openai/openai-node/compare/v4.16.0...v4.16.1)

### Bug Fixes

* **api:** retreival -&gt; retrieval ([#437](https://github.com/openai/openai-node/issues/437)) ([b4bd3ee](https://github.com/openai/openai-node/commit/b4bd3eefdd3903abcc57c431382cc2124d39307b))


### Documentation

* **api:** improve docstrings ([#435](https://github.com/openai/openai-node/issues/435)) ([ee8b24c](https://github.com/openai/openai-node/commit/ee8b24c70a5ccb944e02ff2201668d6bc2b597b3))

## 4.16.0 (2023-11-06)

Full Changelog: [v4.15.4...v4.16.0](https://github.com/openai/openai-node/compare/v4.15.4...v4.16.0)

### Features

* **api:** releases from DevDay; assistants, multimodality, tools, dall-e-3, tts, and more ([#433](https://github.com/openai/openai-node/issues/433)) ([fb92f5e](https://github.com/openai/openai-node/commit/fb92f5e6e3b6e7969b3d91f4ccdaef87e5fea0a4))


### Bug Fixes

* improve deno readme ([#429](https://github.com/openai/openai-node/issues/429)) ([871ceac](https://github.com/openai/openai-node/commit/871ceac2b37f53f7fc7c0163454115c709cd7ced))


### Documentation

* deno version ([#432](https://github.com/openai/openai-node/issues/432)) ([74bf336](https://github.com/openai/openai-node/commit/74bf3364379fd23252fde01401c44b2fa796cba4))
* update deno link in more places ([#431](https://github.com/openai/openai-node/issues/431)) ([5da63d4](https://github.com/openai/openai-node/commit/5da63d4a9143c0ab493b742f7fde22b01a372844))

## 4.15.4 (2023-11-05)

Full Changelog: [v4.15.3...v4.15.4](https://github.com/openai/openai-node/compare/v4.15.3...v4.15.4)

### Documentation

* **readme:** remove redundant whitespace ([#427](https://github.com/openai/openai-node/issues/427)) ([aa3a178](https://github.com/openai/openai-node/commit/aa3a1782914a4a285263e4d070bca73e72ed47ec))

## 4.15.3 (2023-11-04)

Full Changelog: [v4.15.2...v4.15.3](https://github.com/openai/openai-node/compare/v4.15.2...v4.15.3)

### Bug Fixes

* improve deno releases ([#425](https://github.com/openai/openai-node/issues/425)) ([19469f2](https://github.com/openai/openai-node/commit/19469f266ff69a4e549402188d9f6ad87f5a7778))

## 4.15.2 (2023-11-04)

Full Changelog: [v4.15.1...v4.15.2](https://github.com/openai/openai-node/compare/v4.15.1...v4.15.2)

### Documentation

* fix deno.land import ([#423](https://github.com/openai/openai-node/issues/423)) ([e5415a2](https://github.com/openai/openai-node/commit/e5415a29ab447ced8535fafda7928b0a6748c8d1))

## 4.15.1 (2023-11-04)

Full Changelog: [v4.15.0...v4.15.1](https://github.com/openai/openai-node/compare/v4.15.0...v4.15.1)

### Documentation

* document customizing fetch ([#420](https://github.com/openai/openai-node/issues/420)) ([1ca982f](https://github.com/openai/openai-node/commit/1ca982f192daf49e33b7acb5505ed26c9d891255))

## 4.15.0 (2023-11-03)

Full Changelog: [v4.14.2...v4.15.0](https://github.com/openai/openai-node/compare/v4.14.2...v4.15.0)

### Features

* **beta:** add streaming and function calling helpers ([#409](https://github.com/openai/openai-node/issues/409)) ([510c1f3](https://github.com/openai/openai-node/commit/510c1f325ee55197b4c2f434475128c265500746))
* **client:** allow binary returns ([#416](https://github.com/openai/openai-node/issues/416)) ([02f7ad7](https://github.com/openai/openai-node/commit/02f7ad7f736751e0e7687e6744bae464d4e40b79))
* **github:** include a devcontainer setup ([#413](https://github.com/openai/openai-node/issues/413)) ([fb2996f](https://github.com/openai/openai-node/commit/fb2996f0d291210878145aacf9b952f8133d9414))
* streaming improvements ([#411](https://github.com/openai/openai-node/issues/411)) ([37b622c](https://github.com/openai/openai-node/commit/37b622c79ddbd6c286b730e740403c82b542e796))

## 4.14.2 (2023-10-30)

Full Changelog: [v4.14.1...v4.14.2](https://github.com/openai/openai-node/compare/v4.14.1...v4.14.2)

### Chores

* **docs:** update deno link ([#407](https://github.com/openai/openai-node/issues/407)) ([0328882](https://github.com/openai/openai-node/commit/0328882cccb3e5386283ffa5eb9cd8ad9442f3a0))

## 4.14.1 (2023-10-27)

Full Changelog: [v4.14.0...v4.14.1](https://github.com/openai/openai-node/compare/v4.14.0...v4.14.1)

### Bug Fixes

* deploy deno in a github workflow instead of postpublish step ([#405](https://github.com/openai/openai-node/issues/405)) ([3a6dba0](https://github.com/openai/openai-node/commit/3a6dba074258274bffcfe3a4260ca1b95bcd6bdc))
* typo in build script ([#403](https://github.com/openai/openai-node/issues/403)) ([76c5c96](https://github.com/openai/openai-node/commit/76c5c96a359f750f58ea38b5d32365db7e34409a))


### Chores

* **internal:** update gitignore ([#406](https://github.com/openai/openai-node/issues/406)) ([986b0bb](https://github.com/openai/openai-node/commit/986b0bbac9f5ca43a0df6f29f2a468dd4223e053))

## 4.14.0 (2023-10-25)

Full Changelog: [v4.13.0...v4.14.0](https://github.com/openai/openai-node/compare/v4.13.0...v4.14.0)

### Features

* **client:** adjust retry behavior to be exponential backoff ([#400](https://github.com/openai/openai-node/issues/400)) ([2bc14ce](https://github.com/openai/openai-node/commit/2bc14ce300ef020bc045199fe3d76dd352d78ef9))


### Chores

* **docs:** update deno version ([#399](https://github.com/openai/openai-node/issues/399)) ([cdee077](https://github.com/openai/openai-node/commit/cdee0770690d4b66b357d970827e9ba1597ffb89))

## 4.13.0 (2023-10-22)

Full Changelog: [v4.12.4...v4.13.0](https://github.com/openai/openai-node/compare/v4.12.4...v4.13.0)

### Features

* **api:** add embeddings encoding_format ([#390](https://github.com/openai/openai-node/issues/390)) ([cf70dea](https://github.com/openai/openai-node/commit/cf70deaba1426786aba9b938d280c61aeb516e34))
* handle 204 No Content gracefully ([#391](https://github.com/openai/openai-node/issues/391)) ([2dd005c](https://github.com/openai/openai-node/commit/2dd005c1c497605036d3524f19d130b3fc5f8d8b))

## 4.12.4 (2023-10-17)

Full Changelog: [v4.12.3...v4.12.4](https://github.com/openai/openai-node/compare/v4.12.3...v4.12.4)

### Bug Fixes

* import web-streams-polyfill without overriding globals ([#385](https://github.com/openai/openai-node/issues/385)) ([be8e18b](https://github.com/openai/openai-node/commit/be8e18ba4c6a16e7b6413c77246f83230e0b8fc2))

## 4.12.3 (2023-10-16)

Full Changelog: [v4.12.2...v4.12.3](https://github.com/openai/openai-node/compare/v4.12.2...v4.12.3)

### Documentation

* organisation -&gt; organization (UK to US English) ([#382](https://github.com/openai/openai-node/issues/382)) ([516f0ad](https://github.com/openai/openai-node/commit/516f0ade1ec1fd8fc4c78999ee0f656cc2b5ae58))

## 4.12.2 (2023-10-16)

Full Changelog: [v4.12.1...v4.12.2](https://github.com/openai/openai-node/compare/v4.12.1...v4.12.2)

### Bug Fixes

* **client:** correctly handle errors during streaming ([#377](https://github.com/openai/openai-node/issues/377)) ([09233b1](https://github.com/openai/openai-node/commit/09233b1ccc80ee900be19050f438cc8aa9dbb513))
* **client:** correctly handle errors during streaming ([#379](https://github.com/openai/openai-node/issues/379)) ([9ced580](https://github.com/openai/openai-node/commit/9ced5804777a5857d6775a49ddf30ed9cc016fab))
* improve status code in error messages ([#381](https://github.com/openai/openai-node/issues/381)) ([68dfb17](https://github.com/openai/openai-node/commit/68dfb17cce300ade8d29afc854d616833b3283ca))


### Chores

* add case insensitive get header function ([#373](https://github.com/openai/openai-node/issues/373)) ([b088998](https://github.com/openai/openai-node/commit/b088998ae610de54bb8700eefd6b664eb9a2fcc3))
* **internal:** add debug logs for stream responses ([#380](https://github.com/openai/openai-node/issues/380)) ([689db0b](https://github.com/openai/openai-node/commit/689db0b8058527ae5c3af5e457c962d8a6635297))
* show deprecation notice on re-export ([#368](https://github.com/openai/openai-node/issues/368)) ([b176703](https://github.com/openai/openai-node/commit/b176703102998f0e9d8ca2ed93ccd495fd10a6ee))
* update comment ([#376](https://github.com/openai/openai-node/issues/376)) ([a06c685](https://github.com/openai/openai-node/commit/a06c6850bfdd756dc8f07dd1f70218be610faa30))
* update comment ([#378](https://github.com/openai/openai-node/issues/378)) ([b04031d](https://github.com/openai/openai-node/commit/b04031d19210a66f82c7d233a50f7bc427a1bf92))


### Refactors

* **streaming:** change Stream constructor signature ([#370](https://github.com/openai/openai-node/issues/370)) ([71984ed](https://github.com/openai/openai-node/commit/71984edc3141ba99ffa1327bab6a182b4452209f))
* **test:** refactor authentication tests ([#371](https://github.com/openai/openai-node/issues/371)) ([e0d459f](https://github.com/openai/openai-node/commit/e0d459f958451a99e15a11a0e5ea6471abbe1ac1))

## 4.12.1 (2023-10-11)

Full Changelog: [v4.12.0...v4.12.1](https://github.com/openai/openai-node/compare/v4.12.0...v4.12.1)

### Bug Fixes

* fix namespace exports regression ([#366](https://github.com/openai/openai-node/issues/366)) ([b2b1d85](https://github.com/openai/openai-node/commit/b2b1d85d90eef51e689ca75c0ca2f35bb63cccc0))

## 4.12.0 (2023-10-11)

Full Changelog: [v4.11.1...v4.12.0](https://github.com/openai/openai-node/compare/v4.11.1...v4.12.0)

### Features

* **api:** remove `content_filter` stop_reason and update documentation ([#352](https://github.com/openai/openai-node/issues/352)) ([a4b401e](https://github.com/openai/openai-node/commit/a4b401e91a0b3fbf55aedfb6ed6d93396377bf27))
* re-export chat completion types at the top level, and work around webpack limitations ([#365](https://github.com/openai/openai-node/issues/365)) ([bb815d0](https://github.com/openai/openai-node/commit/bb815d0373ae33f58329e34e8983f5b3881db22d))


### Bug Fixes

* prevent ReferenceError, update compatibility to ES2020 and Node 18+ ([#356](https://github.com/openai/openai-node/issues/356)) ([fc71a4b](https://github.com/openai/openai-node/commit/fc71a4b6b73208ff3e8f0c8792a9a03e3790d26b))


### Chores

* **internal:** minor formatting improvement ([#354](https://github.com/openai/openai-node/issues/354)) ([3799863](https://github.com/openai/openai-node/commit/3799863da4ff2a27940ef0b7e57360c72e44d986))

## 4.11.1 (2023-10-03)

Full Changelog: [v4.11.0...v4.11.1](https://github.com/openai/openai-node/compare/v4.11.0...v4.11.1)

## 4.11.0 (2023-09-29)

Full Changelog: [v4.10.0...v4.11.0](https://github.com/openai/openai-node/compare/v4.10.0...v4.11.0)

### Features

* **client:** handle retry-after with a date ([#340](https://github.com/openai/openai-node/issues/340)) ([b6dd384](https://github.com/openai/openai-node/commit/b6dd38488ea7cc4c22495f16d027b7ffdb87da53))
* **package:** export a root error type ([#338](https://github.com/openai/openai-node/issues/338)) ([462bcda](https://github.com/openai/openai-node/commit/462bcda7140611afa20bc25de4aec6d4b205b37d))


### Bug Fixes

* **api:** add content_filter to chat completion finish reason ([#344](https://github.com/openai/openai-node/issues/344)) ([f10c757](https://github.com/openai/openai-node/commit/f10c757d831d90407ba47b4659d9cd34b1a35b1d))


### Chores

* **internal:** bump lock file ([#334](https://github.com/openai/openai-node/issues/334)) ([fd2337b](https://github.com/openai/openai-node/commit/fd2337b018ab2f31bcea8f9feda0ddaf755390c7))
* **internal:** update lock file ([#339](https://github.com/openai/openai-node/issues/339)) ([1bf84b6](https://github.com/openai/openai-node/commit/1bf84b672c386f8ca46bb8fc120eb8d8d48b3a82))
* **internal:** update lock file ([#342](https://github.com/openai/openai-node/issues/342)) ([0001f06](https://github.com/openai/openai-node/commit/0001f062728b0e2047d2bf03b9d947a4be0c7206))
* **internal:** update lock file ([#343](https://github.com/openai/openai-node/issues/343)) ([a02ac8e](https://github.com/openai/openai-node/commit/a02ac8e7f881551527a3cbcadad53b7e424650e8))

## 4.10.0 (2023-09-21)

Full Changelog: [v4.9.1...v4.10.0](https://github.com/openai/openai-node/compare/v4.9.1...v4.10.0)

### Features

* **api:** add 'gpt-3.5-turbo-instruct', fine-tune error objects, update documentation ([#329](https://github.com/openai/openai-node/issues/329)) ([e5f3852](https://github.com/openai/openai-node/commit/e5f385233737002b4bb47a94cba33da7fedfe64d))

## 4.10.0 (2023-09-21)

Full Changelog: [v4.9.1...v4.10.0](https://github.com/openai/openai-node/compare/v4.9.1...v4.10.0)

### Features

* **api:** add 'gpt-3.5-turbo-instruct', fine-tune error objects, update documentation ([#329](https://github.com/openai/openai-node/issues/329)) ([e5f3852](https://github.com/openai/openai-node/commit/e5f385233737002b4bb47a94cba33da7fedfe64d))

## 4.9.1 (2023-09-21)

Full Changelog: [v4.9.0...v4.9.1](https://github.com/openai/openai-node/compare/v4.9.0...v4.9.1)

### Documentation

* **README:** fix variable names in some examples ([#327](https://github.com/openai/openai-node/issues/327)) ([5e05b31](https://github.com/openai/openai-node/commit/5e05b31c132545ce166cea92c5f3e4410fd40711))

## 4.9.0 (2023-09-20)

Full Changelog: [v4.8.0...v4.9.0](https://github.com/openai/openai-node/compare/v4.8.0...v4.9.0)

### Features

* **client:** support importing node or web shims manually ([#325](https://github.com/openai/openai-node/issues/325)) ([628f293](https://github.com/openai/openai-node/commit/628f2935a8791625685f68f73db8f3759b8f4f91))

## 4.8.0 (2023-09-15)

Full Changelog: [v4.7.1...v4.8.0](https://github.com/openai/openai-node/compare/v4.7.1...v4.8.0)

### Features

* **errors:** add status code to error message ([#315](https://github.com/openai/openai-node/issues/315)) ([9341219](https://github.com/openai/openai-node/commit/93412197c67cb3fb203f35e3ae0a7c3fb173453e))

## 4.7.1 (2023-09-15)

Full Changelog: [v4.7.0...v4.7.1](https://github.com/openai/openai-node/compare/v4.7.0...v4.7.1)

### Documentation

* declare Bun 1.0 officially supported ([#314](https://github.com/openai/openai-node/issues/314)) ([a16e268](https://github.com/openai/openai-node/commit/a16e26863390235cb43e2fe0e569298a4f84c32f))

## 4.7.0 (2023-09-14)

Full Changelog: [v4.6.0...v4.7.0](https://github.com/openai/openai-node/compare/v4.6.0...v4.7.0)

### Features

* **client:** retry on 408 Request Timeout ([#310](https://github.com/openai/openai-node/issues/310)) ([1f98eac](https://github.com/openai/openai-node/commit/1f98eac5be956e56d75ef5456115165b45a4763c))
* make docs urls in comments absolute ([#306](https://github.com/openai/openai-node/issues/306)) ([9db3819](https://github.com/openai/openai-node/commit/9db381961e38d2280b0602447e7d91691b327bde))

## 4.6.0 (2023-09-08)

Full Changelog: [v4.5.0...v4.6.0](https://github.com/openai/openai-node/compare/v4.5.0...v4.6.0)

### Features

* **types:** extract ChatCompletionRole enum to its own type ([#298](https://github.com/openai/openai-node/issues/298)) ([5893e37](https://github.com/openai/openai-node/commit/5893e37406ff85331c85a3baa519ca3051a28e00))


### Bug Fixes

* fix module not found errors in Vercel edge ([#300](https://github.com/openai/openai-node/issues/300)) ([47c79fe](https://github.com/openai/openai-node/commit/47c79fee0fa715ad04410e73530829602736d85f))

## 4.5.0 (2023-09-06)

Full Changelog: [v4.4.0...v4.5.0](https://github.com/openai/openai-node/compare/v4.4.0...v4.5.0)

### Features

* **client:** add files.waitForProcessing() method ([#292](https://github.com/openai/openai-node/issues/292)) ([ef59010](https://github.com/openai/openai-node/commit/ef59010cab0c666fa8a437ec6e27800789aa8705))
* fixes tests where an array has to have unique enum values ([#290](https://github.com/openai/openai-node/issues/290)) ([a10b895](https://github.com/openai/openai-node/commit/a10b8956b3eaae7cdcb90329a8386a41219ca021))
* make docs more readable by eliminating unnecessary escape sequences ([#287](https://github.com/openai/openai-node/issues/287)) ([a068043](https://github.com/openai/openai-node/commit/a06804314d4815d420c97f6f965c926ea70d56df))


### Bug Fixes

* **client:** fix TS errors that appear when users Go to Source in VSCode ([#281](https://github.com/openai/openai-node/issues/281)) ([8dc59bc](https://github.com/openai/openai-node/commit/8dc59bcf924cc991747ca475c714d915e04c6012)), closes [#249](https://github.com/openai/openai-node/issues/249)
* **client:** handle case where the client is instantiated with a undefined baseURL ([#285](https://github.com/openai/openai-node/issues/285)) ([5095cf3](https://github.com/openai/openai-node/commit/5095cf340743e4627b4f0ad2f055ebe332824d23))
* **client:** use explicit file extensions in _shims imports ([#276](https://github.com/openai/openai-node/issues/276)) ([16fe929](https://github.com/openai/openai-node/commit/16fe929688d35c2ebe52c8cf1c1570bafda5f97e))


### Documentation

* **api:** update docstrings ([#286](https://github.com/openai/openai-node/issues/286)) ([664e953](https://github.com/openai/openai-node/commit/664e9532c8acfbf981e9a788ab40c111ebe2fda0))
* **readme:** add link to api.md ([#291](https://github.com/openai/openai-node/issues/291)) ([0d1cce2](https://github.com/openai/openai-node/commit/0d1cce26cdc6567c10c8d72bbc72a788ffb8f2be))

## 4.4.0 (2023-09-01)

Full Changelog: [v4.3.1...v4.4.0](https://github.com/openai/openai-node/compare/v4.3.1...v4.4.0)

### Features

* **package:** add Bun export map ([#269](https://github.com/openai/openai-node/issues/269)) ([16f239c](https://github.com/openai/openai-node/commit/16f239c6b4e8526371b01c511d2e0ebba4c5c8c6))
* re-export chat completion types at the top level ([#268](https://github.com/openai/openai-node/issues/268)) ([1a71a39](https://github.com/openai/openai-node/commit/1a71a39421828fdde7b8605094363a5047d2fdc9))
* **tests:** unskip multipart form data tests ([#275](https://github.com/openai/openai-node/issues/275)) ([47d3e18](https://github.com/openai/openai-node/commit/47d3e18a3ee987d04b958dad1a51821ad5472d54))
* **types:** fix ambiguous auto-import for chat completions params ([#266](https://github.com/openai/openai-node/issues/266)) ([19c99fb](https://github.com/openai/openai-node/commit/19c99fb268d6d6c7fc7aaa66475c35f45d12b4bd))


### Bug Fixes

* revert import change which triggered circular import bug in webpack ([#274](https://github.com/openai/openai-node/issues/274)) ([6534e36](https://github.com/openai/openai-node/commit/6534e3620d7e2983e98b42cf95fa966deab1ab1d))

## 4.3.1 (2023-08-29)

Full Changelog: [v4.3.0...v4.3.1](https://github.com/openai/openai-node/compare/v4.3.0...v4.3.1)

### Bug Fixes

* **types:** improve getNextPage() return type ([#262](https://github.com/openai/openai-node/issues/262)) ([245a984](https://github.com/openai/openai-node/commit/245a9847d1ba5bbe5262bc06b2f7bb7385cd3a9a))


### Chores

* **ci:** setup workflows to create releases and release PRs ([#259](https://github.com/openai/openai-node/issues/259)) ([290908c](https://github.com/openai/openai-node/commit/290908ce24dc6c31df18b2eb7808d5b495387454))

## [4.3.0](https://github.com/openai/openai-node/compare/v4.2.0...v4.3.0) (2023-08-27)


### Features

* **client:** add auto-pagination to fine tuning list endpoints ([#254](https://github.com/openai/openai-node/issues/254)) ([5f89c5e](https://github.com/openai/openai-node/commit/5f89c5e6b9088cc2e86405a32b60cae91c078ce1))
* **cli:** rewrite in JS for better compatibility ([#244](https://github.com/openai/openai-node/issues/244)) ([d8d7c05](https://github.com/openai/openai-node/commit/d8d7c0592bfad89669cd2f174e6207370cd7d3fb))


### Bug Fixes

* **stream:** declare Stream.controller as public ([#252](https://github.com/openai/openai-node/issues/252)) ([81e5de7](https://github.com/openai/openai-node/commit/81e5de7ba94c992cafa3d08e2697c8122382497a))


### Documentation

* **readme:** mention Azure support ([#253](https://github.com/openai/openai-node/issues/253)) ([294727a](https://github.com/openai/openai-node/commit/294727ad3543d91ef59df285ce1616c442d369db))


### Chores

* **internal:** add helper method ([#255](https://github.com/openai/openai-node/issues/255)) ([6d8cff0](https://github.com/openai/openai-node/commit/6d8cff00164c0f65ed40b941486f2e0d752feb1e))

## [4.2.0](https://github.com/openai/openai-node/compare/v4.1.0...v4.2.0) (2023-08-23)


### Features

* **types:** export RequestOptions type ([#240](https://github.com/openai/openai-node/issues/240)) ([ecf3bce](https://github.com/openai/openai-node/commit/ecf3bcee3c64a80a3cd901aa32d3db78d1364645))


### Chores

* **internal:** export HeadersInit type shim ([#241](https://github.com/openai/openai-node/issues/241)) ([cf9f672](https://github.com/openai/openai-node/commit/cf9f6729b5b232a37841c33db33b2519b54f19b2))
