import * as _$vitest from "vitest";

//#region src/test-utils/vitest-mock-fn.d.ts
type MockFn<T extends (...args: any[]) => any = (...args: any[]) => any> = _$vitest.Mock<T>;
//#endregion
export { MockFn as t };