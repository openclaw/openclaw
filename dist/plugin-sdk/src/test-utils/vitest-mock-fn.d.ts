export type MockFn<T extends (...args: any[]) => any = (...args: any[]) => any> = import("vitest").Mock<T>;
