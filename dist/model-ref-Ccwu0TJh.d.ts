//#region src/video-generation/model-ref.d.ts
declare function parseVideoGenerationModelRef(raw: string | undefined): {
  provider: string;
  model: string;
} | null;
//#endregion
export { parseVideoGenerationModelRef as t };