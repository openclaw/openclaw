export declare class BrowserError extends Error {
    status: number;
    constructor(message: string, status?: number, options?: ErrorOptions);
}
export declare class BrowserValidationError extends BrowserError {
    constructor(message: string, options?: ErrorOptions);
}
export declare class BrowserConfigurationError extends BrowserError {
    constructor(message: string, options?: ErrorOptions);
}
export declare class BrowserTargetAmbiguousError extends BrowserError {
    constructor(message?: string, options?: ErrorOptions);
}
export declare class BrowserTabNotFoundError extends BrowserError {
    constructor(message?: string, options?: ErrorOptions);
}
export declare class BrowserProfileNotFoundError extends BrowserError {
    constructor(message: string, options?: ErrorOptions);
}
export declare class BrowserConflictError extends BrowserError {
    constructor(message: string, options?: ErrorOptions);
}
export declare class BrowserResetUnsupportedError extends BrowserError {
    constructor(message: string, options?: ErrorOptions);
}
export declare class BrowserProfileUnavailableError extends BrowserError {
    constructor(message: string, options?: ErrorOptions);
}
export declare class BrowserResourceExhaustedError extends BrowserError {
    constructor(message: string, options?: ErrorOptions);
}
export declare function toBrowserErrorResponse(err: unknown): {
    status: number;
    message: string;
} | null;
