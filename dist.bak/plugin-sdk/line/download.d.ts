interface DownloadResult {
    path: string;
    contentType?: string;
    size: number;
}
export declare function downloadLineMedia(messageId: string, channelAccessToken: string, maxBytes?: number): Promise<DownloadResult>;
export {};
