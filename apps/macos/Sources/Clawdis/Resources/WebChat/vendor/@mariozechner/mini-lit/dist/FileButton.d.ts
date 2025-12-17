import { type ButtonProps } from "./Button.js";
export interface FileButtonProps extends Omit<ButtonProps, "onClick"> {
    accept?: string;
    multiple?: boolean;
    maxFileSize?: number;
    onFilesSelected?: (files: File[]) => void;
}
export declare const FileButton: ({ accept, multiple, maxFileSize, onFilesSelected, disabled, loading, ...buttonProps }: FileButtonProps) => import("lit-html").TemplateResult<1>;
//# sourceMappingURL=FileButton.d.ts.map