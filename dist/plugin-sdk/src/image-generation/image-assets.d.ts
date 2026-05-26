import type { GeneratedImageAsset, ImageGenerationSourceImage } from "./types.js";
export type ImageMimeTypeDetection = {
    mimeType: string;
    extension: string;
};
export type OpenAiCompatibleImageResponseEntry = {
    b64_json?: unknown;
    mime_type?: unknown;
    revised_prompt?: unknown;
};
export type OpenAiCompatibleImageResponsePayload = {
    data?: OpenAiCompatibleImageResponseEntry[];
};
export declare function imageFileExtensionForMimeType(mimeType: string | undefined, fallback?: string): string;
export declare function sniffImageMimeType(buffer: Buffer, fallbackMimeType?: string): ImageMimeTypeDetection;
export declare function toImageDataUrl(params: {
    buffer: Buffer;
    mimeType?: string;
    defaultMimeType?: string;
}): string;
export declare function parseImageDataUrl(dataUrl: string): {
    mimeType: string;
    base64: string;
} | undefined;
export declare function generatedImageAssetFromBase64(params: {
    base64: string | undefined;
    index: number;
    mimeType?: string;
    revisedPrompt?: string;
    defaultMimeType?: string;
    fileNamePrefix?: string;
    sniffMimeType?: boolean;
}): GeneratedImageAsset | undefined;
export declare function generatedImageAssetFromDataUrl(params: {
    dataUrl: string;
    index: number;
    fileNamePrefix?: string;
}): GeneratedImageAsset | undefined;
export declare function generatedImageAssetFromOpenAiCompatibleEntry(entry: OpenAiCompatibleImageResponseEntry, index: number, options?: {
    defaultMimeType?: string;
    fileNamePrefix?: string;
    sniffMimeType?: boolean;
}): GeneratedImageAsset | undefined;
export declare function parseOpenAiCompatibleImageResponse(payload: OpenAiCompatibleImageResponsePayload, options?: {
    defaultMimeType?: string;
    fileNamePrefix?: string;
    sniffMimeType?: boolean;
}): GeneratedImageAsset[];
export declare function imageSourceUploadFileName(params: {
    image: ImageGenerationSourceImage;
    index: number;
    defaultMimeType?: string;
    fileNamePrefix?: string;
}): string;
