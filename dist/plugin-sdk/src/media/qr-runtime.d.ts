import type QRCode from "qrcode";
type QrCodeRuntime = typeof QRCode;
export declare function loadQrCodeRuntime(): Promise<QrCodeRuntime>;
export declare function normalizeQrText(text: string): string;
export {};
