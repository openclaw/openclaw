export type ModelFile = { name: string; path?: string; bytes: number; sha256: string };
export type ModelPreset = {
  id: string;
  name: string;
  family: "gliclass" | "gliner" | "deberta";
  maxTokens: number;
  source:
    | { kind: "hub"; repository: string; revision: string; files: ModelFile[] }
    | { kind: "local-export"; repository: string; revision: string };
};

export const MODELS: readonly ModelPreset[] = [
  {
    id: "gliclass-edge-v3.0",
    name: "GLiClass Edge v3",
    family: "gliclass",
    maxTokens: 512,
    source: {
      kind: "hub",
      repository: "cnmoro/gliclass-edge-v3.0-onnx",
      revision: "1167c26c90183f20165120292dc5c7684af406ae",
      files: [
        {
          name: "model.onnx",
          path: "model.onnx",
          bytes: 131130181,
          sha256: "5289497ae11bb612806e56eefa168c6338e3e5d9f548e8012f1e10560e19fa8f",
        },
        {
          name: "tokenizer.json",
          path: "tokenizer.json",
          bytes: 3583864,
          sha256: "b6e09abceac75851eae141e7d51224a9da835c0c03684282fe2d5c42c745754f",
        },
      ],
    },
  },
  {
    id: "gliclass-base-v3.0",
    name: "GLiClass Base v3",
    family: "gliclass",
    maxTokens: 512,
    source: {
      kind: "hub",
      repository: "cnmoro/gliclass-base-v3.0-onnx",
      revision: "8acca975fd47e89e15f13a4f5446f2ccd1dcf7bb",
      files: [
        {
          name: "model.onnx",
          path: "model.onnx",
          bytes: 747316021,
          sha256: "1395fde4ae8de8e41f51080c18a09c48c704b5a1dd34d78950b6c9a11efddd7b",
        },
        {
          name: "tokenizer.json",
          path: "tokenizer.json",
          bytes: 8649499,
          sha256: "9db2e87fbab9819100edd8d6dc7a54f82167045d04bfb752039dae4efb9cd85c",
        },
      ],
    },
  },
  {
    id: "gliner2.5-small-v1",
    name: "GLiNER 2.5 Small",
    family: "gliner",
    maxTokens: 512,
    source: {
      kind: "hub",
      repository: "nicolasembleton/gliner2.5-small-v1-onnx",
      revision: "5e2e3f51adfb0eeb7c1f83464400b4d498d41659",
      files: [
        {
          name: "model.onnx",
          path: "onnx/model.onnx",
          bytes: 288521577,
          sha256: "12dda5cf4b0e9ed3af17596cef1cdbd22185a32fcc230af4f476353b5e4ade1f",
        },
        {
          name: "tokenizer.json",
          path: "tokenizer.json",
          bytes: 8341713,
          sha256: "cbc8ae6037812709c9c26f2a160f8dc48b0440bcb79c8141804259ae2d6adac3",
        },
        {
          name: "tokenizer_config.json",
          path: "tokenizer_config.json",
          bytes: 646,
          sha256: "fd4a31dc2f1f17e31638c5f0e783b81cdb2fbe6bddd116a8d9e5d50d78148cf1",
        },
      ],
    },
  },
  {
    id: "gliner2.5-base-v1",
    name: "GLiNER 2.5 Base",
    family: "gliner",
    maxTokens: 512,
    source: {
      kind: "hub",
      repository: "nicolasembleton/gliner2.5-base-v1-onnx",
      revision: "b29dcb3c273644e833837933533ac37274fe585e",
      files: [
        {
          name: "model.onnx",
          path: "onnx/model.onnx",
          bytes: 746400205,
          sha256: "db56fe723c14e856ab5618a5bceb66b55a1e8d2cf5f3026202c45e6ff4b86f42",
        },
        {
          name: "tokenizer.json",
          path: "tokenizer.json",
          bytes: 8341713,
          sha256: "cbc8ae6037812709c9c26f2a160f8dc48b0440bcb79c8141804259ae2d6adac3",
        },
        {
          name: "tokenizer_config.json",
          path: "tokenizer_config.json",
          bytes: 646,
          sha256: "fd4a31dc2f1f17e31638c5f0e783b81cdb2fbe6bddd116a8d9e5d50d78148cf1",
        },
      ],
    },
  },
  {
    id: "deberta-v3-base-zeroshot-v2.0",
    name: "DeBERTa Zero-shot v2",
    family: "deberta",
    maxTokens: 512,
    source: {
      kind: "hub",
      repository: "MoritzLaurer/deberta-v3-base-zeroshot-v2.0",
      revision: "8e7e5af5983a0ddb1a5b45a38b129ab69e2258e8",
      files: [
        {
          name: "model.onnx",
          path: "onnx/model.onnx",
          bytes: 738563249,
          sha256: "d46fa6c1addc598abd34af8651120291f51417ddfce45b9d5f70bc32d3efa81c",
        },
        {
          name: "config.json",
          path: "config.json",
          bytes: 1016,
          sha256: "a1c8011b852ae46d6ac26160d358fa595861d261352885f8f7bfcd2811030d9f",
        },
        {
          name: "tokenizer.json",
          path: "tokenizer.json",
          bytes: 8656646,
          sha256: "05402ffae6dd382a8491b1d29bfc139bec5d332662e86a026f433ce54c25c202",
        },
        {
          name: "tokenizer_config.json",
          path: "tokenizer_config.json",
          bytes: 1256,
          sha256: "f5a1a74a632c0e9225e09a21ddf60c2e70ef5d3bfc1f261a24fd8ddab27254d2",
        },
      ],
    },
  },
  {
    id: "gliclass-instruct-edge-v1.0",
    name: "GLiClass Instruct Edge (local export)",
    family: "gliclass",
    maxTokens: 512,
    source: {
      kind: "local-export",
      repository: "knowledgator/gliclass-instruct-edge-v1.0",
      revision: "727be8a417f6a7718e591b025e07054c146d8139",
    },
  },
  {
    id: "gliclass-instruct-base-v1.0",
    name: "GLiClass Instruct Base (local export)",
    family: "gliclass",
    maxTokens: 512,
    source: {
      kind: "local-export",
      repository: "knowledgator/gliclass-instruct-base-v1.0",
      revision: "4f6a108b08a5537f395521d19b5073e197923dd3",
    },
  },
];

export function findModel(id: string): ModelPreset | undefined {
  return MODELS.find((model) => model.id === id);
}
