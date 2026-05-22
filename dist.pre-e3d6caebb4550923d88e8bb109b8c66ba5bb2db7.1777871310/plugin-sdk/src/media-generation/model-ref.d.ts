type ParsedGenerationModelRef = {
    provider: string;
    model: string;
};
export declare function parseGenerationModelRef(raw: string | undefined): ParsedGenerationModelRef | null;
export {};
