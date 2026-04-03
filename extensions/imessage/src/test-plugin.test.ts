import { afterEach, describe, expect, it } from "vitest";
import {
  listImportedBundledPluginFacadeIds,
  resetFacadeRuntimeStateForTest,
} from "../../../src/plugin-sdk/facade-runtime.js";
import { createIMessageTestPlugin } from "./test-plugin.js";

afterEach(() => {
  resetFacadeRuntimeStateForTest();
});

describe("createIMessageTestPlugin", () => {
  it("does not load the bundled iMessage facade by default", () => {
    expect(listImportedBundledPluginFacadeIds()).toEqual([]);

    createIMessageTestPlugin();

    expect(listImportedBundledPluginFacadeIds()).toEqual([]);
  });
});
