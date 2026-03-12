export declare const PAIRING_TOKEN_BYTES = 32;
export declare function generatePairingToken(): string;
export declare function verifyPairingToken(provided: string, expected: string): boolean;
