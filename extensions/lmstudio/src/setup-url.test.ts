import { expect, it, vi } from "vitest";
import { promptAndConfigureLmstudioInteractive } from "./setup.js";

it("rejects invalid setup URLs inline and accepts corrected host shorthand", async () => {
  const stopAfterValidation = new Error("Stop before model discovery");
  const promptText: NonNullable<
    Parameters<typeof promptAndConfigureLmstudioInteractive>[0]["promptText"]
  > = vi.fn(async (prompt) => {
    expect(prompt.message).toBe("LM Studio base URL");
    for (const invalid of [
      "http://",
      "https://",
      "/v1",
      "not a valid URL",
      "ftp://localhost:1234",
    ]) {
      expect(prompt.validate?.(invalid)).toMatch(/HTTP.*URL/i);
    }
    expect(prompt.validate?.("localhost:1234/api/v1/")).toBeUndefined();
    expect(prompt.validate?.("https://models.example.com/v1")).toBeUndefined();
    throw stopAfterValidation;
  });

  await expect(promptAndConfigureLmstudioInteractive({ config: {}, promptText })).rejects.toBe(
    stopAfterValidation,
  );
  expect(promptText).toHaveBeenCalledTimes(1);
});
