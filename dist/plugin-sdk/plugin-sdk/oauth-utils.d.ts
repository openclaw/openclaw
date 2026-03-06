export declare function toFormUrlEncoded(data: Record<string, string>): string;
export declare function generatePkceVerifierChallenge(): {
    verifier: string;
    challenge: string;
};
