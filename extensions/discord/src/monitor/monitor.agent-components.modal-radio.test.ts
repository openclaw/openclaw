import type { ModalInteraction } from "@buape/carbon";
import { ComponentType } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { resolveModalFieldValues } from "./agent-components-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ModalInteraction mock whose rawData.data.components list
 * contains whatever the caller provides.  The fields handler is stubbed to
 * throw for any getText/getStringSelect call so tests that reach it
 * accidentally will fail loudly.
 */
const makeModalInteraction = (
  overrides: {
    rawDataComponents?: unknown[];
    rawData?: unknown;
  } = {},
): ModalInteraction => {
  const rawData =
    overrides.rawData !== undefined
      ? overrides.rawData
      : {
          data: {
            components: overrides.rawDataComponents ?? [],
          },
        };

  return {
    rawData,
    fields: {
      getText: () => {
        throw new Error("not a text field");
      },
      getStringSelect: () => {
        throw new Error("not a select field");
      },
      getRoleSelect: () => {
        throw new Error("not a role select field");
      },
      getUserSelect: () => {
        throw new Error("not a user select field");
      },
    },
  } as unknown as ModalInteraction;
};

/**
 * Build a raw Label+RadioGroup component pair as Discord sends it in a modal
 * submit payload.
 *
 * ComponentType.Label  = 18
 * ComponentType.RadioGroup = 21
 */
const makeRadioComponent = (fieldId: string, value: string | null) => ({
  type: ComponentType.Label, // 18
  component: {
    type: ComponentType.RadioGroup, // 21
    custom_id: fieldId,
    value,
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveModalFieldValues – radio branch", () => {
  it("returns the mapped option label when the radio has a matching value", () => {
    const interaction = makeModalInteraction({
      rawDataComponents: [makeRadioComponent("size", "lg")],
    });

    const result = resolveModalFieldValues(
      {
        id: "size",
        type: "radio",
        label: "Size",
        required: false,
        options: [
          { value: "sm", label: "Small" },
          { value: "lg", label: "Large" },
        ],
      },
      interaction,
    );

    expect(result).toEqual(["Large"]);
  });

  it("returns the raw value when the selected value is not in the options list", () => {
    const interaction = makeModalInteraction({
      rawDataComponents: [makeRadioComponent("size", "xl")],
    });

    const result = resolveModalFieldValues(
      {
        id: "size",
        type: "radio",
        label: "Size",
        required: false,
        options: [
          { value: "sm", label: "Small" },
          { value: "lg", label: "Large" },
        ],
      },
      interaction,
    );

    // mapOptionLabels falls back to the raw value when not found
    expect(result).toEqual(["xl"]);
  });

  it("returns [] when radio has no value and field is not required", () => {
    const interaction = makeModalInteraction({
      rawDataComponents: [makeRadioComponent("size", null)],
    });

    const result = resolveModalFieldValues(
      {
        id: "size",
        type: "radio",
        label: "Size",
        required: false,
        options: [{ value: "sm", label: "Small" }],
      },
      interaction,
    );

    expect(result).toEqual([]);
  });

  it("throws 'Missing required field' when radio has no value and field is required", () => {
    const interaction = makeModalInteraction({
      rawDataComponents: [makeRadioComponent("size", null)],
    });

    expect(() =>
      resolveModalFieldValues(
        {
          id: "size",
          type: "radio",
          label: "Size",
          required: true,
          options: [{ value: "sm", label: "Small" }],
        },
        interaction,
      ),
    ).toThrow("Missing required field: size");
  });

  it("returns [] (non-required) when rawData.data is undefined (malformed payload)", () => {
    // Simulate a payload where rawData exists but data is absent
    const interaction = makeModalInteraction({
      rawData: {
        /* no data key */
      },
    });

    const result = resolveModalFieldValues(
      {
        id: "size",
        type: "radio",
        label: "Size",
        required: false,
        options: [{ value: "sm", label: "Small" }],
      },
      interaction,
    );

    expect(result).toEqual([]);
  });

  it("resolves value from the correct Label+RadioGroup structure (type=Label wrapping RadioGroup)", () => {
    // Ensure the component traversal correctly handles the Label wrapper
    const interaction = makeModalInteraction({
      rawDataComponents: [
        // A different field first, to verify we match by custom_id
        makeRadioComponent("color", "blue"),
        makeRadioComponent("size", "md"),
      ],
    });

    const result = resolveModalFieldValues(
      {
        id: "size",
        type: "radio",
        label: "Size",
        required: true,
        options: [
          { value: "sm", label: "Small" },
          { value: "md", label: "Medium" },
          { value: "lg", label: "Large" },
        ],
      },
      interaction,
    );

    expect(result).toEqual(["Medium"]);
  });
});
