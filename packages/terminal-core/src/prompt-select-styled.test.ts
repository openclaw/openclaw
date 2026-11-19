// Terminal Core tests cover prompt select styled behavior.
import { describe, expect, it } from "vitest";
import { styleSelectParams } from "./prompt-select-styled-params.js";
import { theme } from "./theme.js";

describe("styleSelectParams", () => {
  it("styles messages and hints without replacing unhinted options", () => {
    const originalLevel = theme.accent.level;
    try {
      theme.accent.level = 1;
      const option = { value: "dev", label: "Dev" };
      const hintedOption = { value: "stable", label: "Stable", hint: "Tagged releases" };
      const input = {
        message: "Pick channel",
        options: [hintedOption, option],
      };
      const params = styleSelectParams(input);

      expect(params).toEqual({
        message: theme.accent("Pick channel"),
        options: [
          { value: "stable", label: "Stable", hint: theme.muted("Tagged releases") },
          { value: "dev", label: "Dev" },
        ],
      });
      expect(params.message).not.toBe(input.message);
      expect(params.options[0]).not.toEqual(hintedOption);
      expect(params.options[1]).toBe(option);
      expect(input).toEqual({
        message: "Pick channel",
        options: [
          { value: "stable", label: "Stable", hint: "Tagged releases" },
          { value: "dev", label: "Dev" },
        ],
      });
    } finally {
      theme.accent.level = originalLevel;
    }
  });
});
