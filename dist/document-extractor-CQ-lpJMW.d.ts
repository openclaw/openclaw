//#region src/plugins/document-extractor-types.d.ts
type DocumentExtractedImage = {
  type: "image";
  data: string;
  mimeType: string;
};
type DocumentExtractionRequest = {
  buffer: Buffer;
  mimeType: string;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  pageNumbers?: number[];
  onImageExtractionError?: (error: unknown) => void;
};
type DocumentExtractionResult = {
  text: string;
  images: DocumentExtractedImage[];
};
type DocumentExtractorPlugin = {
  id: string;
  label: string;
  mimeTypes: readonly string[];
  autoDetectOrder?: number;
  extract: (request: DocumentExtractionRequest) => Promise<DocumentExtractionResult | null>;
};
//#endregion
export { DocumentExtractorPlugin as i, DocumentExtractionRequest as n, DocumentExtractionResult as r, DocumentExtractedImage as t };