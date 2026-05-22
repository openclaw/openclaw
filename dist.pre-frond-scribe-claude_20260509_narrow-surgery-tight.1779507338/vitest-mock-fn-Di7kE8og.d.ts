//#region src/test-utils/vitest-mock-fn.d.ts
type MockFn<T extends (...args: any[]) => any = (...args: any[]) => any> = import("vitest").Mock<T>;
//#endregion
export { MockFn as t };