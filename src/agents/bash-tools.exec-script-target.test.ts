import { describe, expect, it } from "vitest";
import {
  extractInterpreterScriptPathsFromSegment,
  extractScriptTargetFromCommand,
} from "./bash-tools.exec-script-target.js";

describe("script targets with empty quoted option values", () => {
  it("keeps the interpreter after an empty env argv0 value", () => {
    expect(extractScriptTargetFromCommand('env --argv0 "" python script.py')).toEqual({
      kind: "python",
      relOrAbsPaths: ["script.py"],
    });
  });

  it("keeps Node preload options after empty inline code", () => {
    expect(extractInterpreterScriptPathsFromSegment('node --eval "" --require preload.js')).toEqual(
      ["preload.js"],
    );
  });
});
