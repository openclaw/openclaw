import { ComponentType } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import type { DiscordModalEntry } from "../components.types.js";
import { createInteraction, ModalInteraction } from "../internal/interactions.js";
import {
  createInternalModalInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { formatModalSubmissionText } from "./agent-components-data.js";

describe("Discord modal submission text", () => {
  it.each([
    { name: "omitted", resolved: undefined, expected: "111, 222" },
    {
      name: "incomplete",
      resolved: { roles: { "111": { id: "111", name: "Maintainers" } } },
      expected: "Maintainers, 222",
    },
  ])("preserves selected role IDs when resolved metadata is $name", ({ resolved, expected }) => {
    const interaction = createInteraction(
      createInternalTestClient(),
      createInternalModalInteractionPayload({
        id: "modal-submit",
        token: "synthetic-token",
        data: {
          custom_id: "modal-roles",
          components: [
            {
              type: ComponentType.Label,
              component: {
                type: ComponentType.RoleSelect,
                custom_id: "roles",
                values: ["111", "222"],
              },
            },
          ],
          ...(resolved ? { resolved } : {}),
        },
      }),
    );
    if (!(interaction instanceof ModalInteraction)) {
      throw new Error("expected a native modal submission");
    }
    const entry: DiscordModalEntry = {
      id: "modal-roles",
      title: "Role selection",
      fields: [{ id: "roles", name: "roles", type: "role-select", label: "Roles", required: true }],
    };

    expect(formatModalSubmissionText(entry, interaction)).toBe(
      `Form "Role selection" submitted.\n- Roles: ${expected}`,
    );
  });
});
