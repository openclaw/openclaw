import { Container } from "@mariozechner/pi-tui";
type BtwInlineMessageParams = {
    question: string;
    text: string;
    isError?: boolean;
};
export declare class BtwInlineMessage extends Container {
    constructor(params: BtwInlineMessageParams);
    setResult(params: BtwInlineMessageParams): void;
}
export {};
