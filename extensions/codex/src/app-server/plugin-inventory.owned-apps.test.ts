import { describe, expect, it } from "vitest";
import { toCodexPluginOwnedAccountApp } from "./plugin-inventory.js";

const approvalAppMetadata = {
  id: "linear",
  name: "linear",
  description: null,
  iconUrl: null,
  iconUrlDark: null,
  distributionChannel: null,
  installUrl: null,
  pluginDisplayNames: [],
  toolSummaries: null,
};

describe("Codex owned app approval metadata", () => {
  it("keeps approval checks conservative when tool metadata is absent", () => {
    expect(toCodexPluginOwnedAccountApp(approvalAppMetadata, undefined)).not.toHaveProperty(
      "approvalOverrideToolConfigKeys",
    );
    expect(
      toCodexPluginOwnedAccountApp({ ...approvalAppMetadata, toolSummaries: [] }, undefined)
        .approvalOverrideToolConfigKeys,
    ).toStrictEqual([]);
  });

  it("retains disabled writable tools in the approval boundary", () => {
    expect(
      toCodexPluginOwnedAccountApp(
        {
          ...approvalAppMetadata,
          toolSummaries: [
            {
              name: "save_issue",
              title: "Save issue",
              description: "Create or update an issue.",
              isEnabled: false,
              disabledReason: "App policy",
              isReadOnly: false,
            },
          ],
        },
        undefined,
      ).approvalOverrideToolConfigKeys,
    ).toStrictEqual(["Save issue", "linear_save_issue", "save_issue"]);
  });

  it("preserves writable approval checks for keys shared with read-only tools", () => {
    const app = {
      ...approvalAppMetadata,
      toolSummaries: [
        {
          name: "fetch",
          title: "Fetch",
          description: "Fetch a Linear issue.",
          isEnabled: true,
          disabledReason: null,
          isReadOnly: true,
        },
        {
          name: "linear_fetch",
          title: "Save issue",
          description: "Create or update a Linear issue.",
          isEnabled: true,
          disabledReason: null,
          isReadOnly: false,
        },
      ],
    };

    expect(
      toCodexPluginOwnedAccountApp(app, undefined).approvalOverrideToolConfigKeys,
    ).toStrictEqual(["Save issue", "linear_fetch", "linear_linear_fetch"]);
  });
});
