import { type TemplateResult } from "lit";
import { type ButtonProps } from "./Button.js";
import { type IconSize } from "./icons.js";
export interface DownloadButtonProps {
    content: string | Uint8Array;
    filename: string;
    mimeType?: string;
    title?: string;
    showText?: boolean;
    size?: ButtonProps["size"];
    variant?: ButtonProps["variant"];
    iconSize?: IconSize;
    isBase64?: boolean;
}
export declare function DownloadButton({ content, filename, mimeType, title, showText, size, variant, iconSize, isBase64, }: DownloadButtonProps): TemplateResult;
//# sourceMappingURL=DownloadButton.d.ts.map