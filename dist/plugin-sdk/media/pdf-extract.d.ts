export type PdfExtractedImage = {
    type: "image";
    data: string;
    mimeType: string;
};
export type PdfExtractedContent = {
    text: string;
    images: PdfExtractedImage[];
};
export declare function extractPdfContent(params: {
    buffer: Buffer;
    maxPages: number;
    maxPixels: number;
    minTextChars: number;
    pageNumbers?: number[];
    onImageExtractionError?: (error: unknown) => void;
}): Promise<PdfExtractedContent>;
