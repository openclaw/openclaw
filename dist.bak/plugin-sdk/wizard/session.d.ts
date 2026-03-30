import { type WizardPrompter } from "./prompts.js";
export type WizardStepOption = {
    value: unknown;
    label: string;
    hint?: string;
};
export type WizardStep = {
    id: string;
    type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress" | "action";
    title?: string;
    message?: string;
    options?: WizardStepOption[];
    initialValue?: unknown;
    placeholder?: string;
    sensitive?: boolean;
    executor?: "gateway" | "client";
};
export type WizardSessionStatus = "running" | "done" | "cancelled" | "error";
export type WizardNextResult = {
    done: boolean;
    step?: WizardStep;
    status: WizardSessionStatus;
    error?: string;
};
export declare class WizardSession {
    private runner;
    private currentStep;
    private stepDeferred;
    private answerDeferred;
    private status;
    private error;
    constructor(runner: (prompter: WizardPrompter) => Promise<void>);
    next(): Promise<WizardNextResult>;
    answer(stepId: string, value: unknown): Promise<void>;
    cancel(): void;
    pushStep(step: WizardStep): void;
    private run;
    awaitAnswer(step: WizardStep): Promise<unknown>;
    private resolveStep;
    getStatus(): WizardSessionStatus;
    getError(): string | undefined;
}
