import { describe, expect, it } from "vitest";

describe("mutating tool error recovery by tool name (#37907)", () => {
  it("clears lastToolError when same tool name succeeds even with different fingerprint", () => {
    type LastToolError = {
      toolName: string;
      meta?: string;
      error?: string;
      mutatingAction?: boolean;
      actionFingerprint?: string;
    };

    const state: { lastToolError: LastToolError | undefined } = {
      lastToolError: {
        toolName: "edit",
        meta: "Edit /src/app.ts",
        error: "Found 2 occurrences, must be unique",
        mutatingAction: true,
        actionFingerprint: "tool=edit|path=/src/app.ts",
      },
    };

    const successToolName = "edit";
    const successFingerprint = "tool=edit|path=/src/app.ts";

    const isSame =
      state.lastToolError!.actionFingerprint != null &&
      successFingerprint != null &&
      state.lastToolError!.actionFingerprint === successFingerprint;

    const sameToolName =
      !isSame &&
      successToolName.trim().toLowerCase() ===
        state.lastToolError!.toolName.trim().toLowerCase();

    if (isSame || sameToolName) {
      state.lastToolError = undefined;
    }

    expect(state.lastToolError).toBeUndefined();
  });

  it("clears lastToolError when same tool name succeeds with missing fingerprint", () => {
    type LastToolError = {
      toolName: string;
      meta?: string;
      error?: string;
      mutatingAction?: boolean;
      actionFingerprint?: string;
    };

    const state: { lastToolError: LastToolError | undefined } = {
      lastToolError: {
        toolName: "edit",
        meta: "Edit /src/app.ts",
        error: "Found 2 occurrences",
        mutatingAction: true,
        actionFingerprint: "tool=edit|path=/src/app.ts",
      },
    };

    const successToolName = "edit";
    const successFingerprint: string | undefined = undefined;

    const isSame =
      state.lastToolError!.actionFingerprint != null &&
      successFingerprint != null &&
      state.lastToolError!.actionFingerprint === successFingerprint;

    const sameToolName =
      !isSame &&
      successToolName.trim().toLowerCase() ===
        state.lastToolError!.toolName.trim().toLowerCase();

    if (isSame || sameToolName) {
      state.lastToolError = undefined;
    }

    expect(state.lastToolError).toBeUndefined();
  });

  it("keeps lastToolError when different tool name succeeds", () => {
    type LastToolError = {
      toolName: string;
      meta?: string;
      error?: string;
      mutatingAction?: boolean;
      actionFingerprint?: string;
    };

    const state: { lastToolError: LastToolError | undefined } = {
      lastToolError: {
        toolName: "edit",
        meta: "Edit /src/app.ts",
        error: "Found 2 occurrences",
        mutatingAction: true,
        actionFingerprint: "tool=edit|path=/src/app.ts",
      },
    };

    const successToolName = "write";
    const successFingerprint = "tool=write|path=/src/other.ts";

    const isSame =
      state.lastToolError!.actionFingerprint != null &&
      successFingerprint != null &&
      state.lastToolError!.actionFingerprint === successFingerprint;

    const sameToolName =
      !isSame &&
      successToolName.trim().toLowerCase() ===
        state.lastToolError!.toolName.trim().toLowerCase();

    if (isSame || sameToolName) {
      state.lastToolError = undefined;
    }

    expect(state.lastToolError).toBeDefined();
    expect(state.lastToolError!.toolName).toBe("edit");
  });
});
