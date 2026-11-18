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

function file(bytes: number, sha256: string, path = "model.onnx"): ModelFile {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, bytes, sha256 };
}

function preset(
  id: string,
  name: string,
  repository: string,
  revision: string,
  files?: ModelFile[],
  family: ModelPreset["family"] = "gliclass",
): ModelPreset {
  return {
    id,
    name,
    family,
    maxTokens: 512,
    source: files
      ? { kind: "hub", repository, revision, files }
      : { kind: "local-export", repository, revision },
  };
}

const gliner25TokenizerFiles: ModelFile[] = [
  file(
    8341713,
    "cbc8ae6037812709c9c26f2a160f8dc48b0440bcb79c8141804259ae2d6adac3",
    "tokenizer.json",
  ),
  file(
    646,
    "fd4a31dc2f1f17e31638c5f0e783b81cdb2fbe6bddd116a8d9e5d50d78148cf1",
    "tokenizer_config.json",
  ),
];

export const MODELS: readonly ModelPreset[] = [
  preset(
    "gliclass-edge-v3.0",
    "GLiClass Edge v3",
    "cnmoro/gliclass-edge-v3.0-onnx",
    "1167c26c90183f20165120292dc5c7684af406ae",
    [
      file(131130181, "5289497ae11bb612806e56eefa168c6338e3e5d9f548e8012f1e10560e19fa8f"),
      file(
        3583864,
        "b6e09abceac75851eae141e7d51224a9da835c0c03684282fe2d5c42c745754f",
        "tokenizer.json",
      ),
    ],
  ),
  preset(
    "gliclass-base-v3.0",
    "GLiClass Base v3",
    "cnmoro/gliclass-base-v3.0-onnx",
    "8acca975fd47e89e15f13a4f5446f2ccd1dcf7bb",
    [
      file(747316021, "1395fde4ae8de8e41f51080c18a09c48c704b5a1dd34d78950b6c9a11efddd7b"),
      file(
        8649499,
        "9db2e87fbab9819100edd8d6dc7a54f82167045d04bfb752039dae4efb9cd85c",
        "tokenizer.json",
      ),
    ],
  ),
  preset(
    "gliner2.5-small-v1",
    "GLiNER 2.5 Small",
    "nicolasembleton/gliner2.5-small-v1-onnx",
    "5e2e3f51adfb0eeb7c1f83464400b4d498d41659",
    [
      file(
        288521577,
        "12dda5cf4b0e9ed3af17596cef1cdbd22185a32fcc230af4f476353b5e4ade1f",
        "onnx/model.onnx",
      ),
      ...gliner25TokenizerFiles,
    ],
    "gliner",
  ),
  preset(
    "gliner2.5-base-v1",
    "GLiNER 2.5 Base",
    "nicolasembleton/gliner2.5-base-v1-onnx",
    "b29dcb3c273644e833837933533ac37274fe585e",
    [
      file(
        746400205,
        "db56fe723c14e856ab5618a5bceb66b55a1e8d2cf5f3026202c45e6ff4b86f42",
        "onnx/model.onnx",
      ),
      ...gliner25TokenizerFiles,
    ],
    "gliner",
  ),
  preset(
    "deberta-v3-base-zeroshot-v2.0",
    "DeBERTa Zero-shot v2",
    "MoritzLaurer/deberta-v3-base-zeroshot-v2.0",
    "8e7e5af5983a0ddb1a5b45a38b129ab69e2258e8",
    [
      file(
        738563249,
        "d46fa6c1addc598abd34af8651120291f51417ddfce45b9d5f70bc32d3efa81c",
        "onnx/model.onnx",
      ),
      file(1016, "a1c8011b852ae46d6ac26160d358fa595861d261352885f8f7bfcd2811030d9f", "config.json"),
      file(
        8656646,
        "05402ffae6dd382a8491b1d29bfc139bec5d332662e86a026f433ce54c25c202",
        "tokenizer.json",
      ),
      file(
        1256,
        "f5a1a74a632c0e9225e09a21ddf60c2e70ef5d3bfc1f261a24fd8ddab27254d2",
        "tokenizer_config.json",
      ),
    ],
    "deberta",
  ),
  preset(
    "gliclass-instruct-edge-v1.0",
    "GLiClass Instruct Edge (local export)",
    "knowledgator/gliclass-instruct-edge-v1.0",
    "727be8a417f6a7718e591b025e07054c146d8139",
  ),
  preset(
    "gliclass-instruct-base-v1.0",
    "GLiClass Instruct Base (local export)",
    "knowledgator/gliclass-instruct-base-v1.0",
    "4f6a108b08a5537f395521d19b5073e197923dd3",
  ),
];

export function findModel(id: string): ModelPreset | undefined {
  return MODELS.find((model) => model.id === id);
}
