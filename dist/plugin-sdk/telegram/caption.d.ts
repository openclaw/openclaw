export declare const TELEGRAM_MAX_CAPTION_LENGTH = 1024;
export declare function splitTelegramCaption(text?: string): {
    caption?: string;
    followUpText?: string;
};
