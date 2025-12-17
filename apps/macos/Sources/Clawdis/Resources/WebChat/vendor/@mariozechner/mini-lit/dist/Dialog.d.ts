import { type BaseComponentProps } from "./mini.js";
export interface DialogProps {
    isOpen: boolean;
    onClose?: () => void;
    children: any;
    width?: string;
    height?: string;
    className?: string;
    backdropClassName?: string;
}
export interface DialogHeaderProps {
    title: string;
    description?: string;
    className?: string;
}
export interface DialogContentProps extends BaseComponentProps {
}
export interface DialogFooterProps extends BaseComponentProps {
}
export declare const Dialog: import("./mini.js").Component<DialogProps>;
export declare const DialogHeader: import("./mini.js").Component<DialogHeaderProps>;
export declare const DialogContent: import("./mini.js").Component<DialogContentProps>;
export declare const DialogFooter: import("./mini.js").Component<DialogFooterProps>;
//# sourceMappingURL=Dialog.d.ts.map