export type RestorableMock = {
    mockRestore(): void;
};
export declare function withRestoredMocks<T>(mocks: readonly RestorableMock[], run: () => Promise<T>): Promise<T>;
export declare function withRestoredMocks<T>(mocks: readonly RestorableMock[], run: () => T): T;
export declare function mockProcessPlatform(platform: NodeJS.Platform): RestorableMock;
export declare function withMockedPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T>;
export declare function withMockedPlatform<T>(platform: NodeJS.Platform, run: () => T): T;
export declare function withMockedWindowsPlatform<T>(run: () => Promise<T>): Promise<T>;
export declare function withMockedWindowsPlatform<T>(run: () => T): T;
