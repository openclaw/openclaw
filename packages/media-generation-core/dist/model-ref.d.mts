//#region src/model-ref.d.ts
type ParsedGenerationModelRef = {
  provider: string;
  model: string;
};
declare function parseGenerationModelRef(raw: string | undefined): ParsedGenerationModelRef | null;
//#endregion
export { ParsedGenerationModelRef, parseGenerationModelRef };