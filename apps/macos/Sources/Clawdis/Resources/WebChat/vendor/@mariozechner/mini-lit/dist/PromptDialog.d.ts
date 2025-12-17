import { type PropertyValues, type TemplateResult } from "lit";
import { DialogBase } from "./DialogBase.js";
export declare class PromptDialog extends DialogBase {
    headerTitle: string;
    message: string;
    defaultValue: string;
    isPassword: boolean;
    private inputValue;
    private resolvePromise?;
    private inputRef;
    protected modalWidth: string;
    protected modalHeight: string;
    static ask(title: string, message: string, defaultValue?: string, isPassword?: boolean): Promise<string | undefined>;
    protected firstUpdated(_changedProperties: PropertyValues): void;
    private handleConfirm;
    private handleCancel;
    protected renderContent(): TemplateResult;
}
export default PromptDialog;
//# sourceMappingURL=PromptDialog.d.ts.map