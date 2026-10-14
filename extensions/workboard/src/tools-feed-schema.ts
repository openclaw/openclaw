// Workboard plugin module defines the agent tool schema for Feed presentation fields.
import { Type } from "typebox";
import { strictObject } from "./tools-card-mutations.js";

export const SnoozeUntilField = Type.Optional(
  Type.Union([Type.String(), Type.Number(), Type.Null()], {
    description:
      'snoozeUntil: hide the card from the owner until this time. ISO-8601 with offset (e.g. "2026-10-16T09:00:00+02:00") or epoch ms; "" or null clears it.',
  }),
);

export const FeedFieldsSchema = {
  tag: Type.Optional(
    Type.String({ description: 'Small uppercase source tag, e.g. "EMAIL · DRAFT".' }),
  ),
  summary: Type.Optional(Type.String({ description: "One muted context line under the title." })),
  body: Type.Optional(
    Type.String({ description: "Longer detail (light markdown). Long text folds behind More." }),
  ),
  draft: Type.Optional(
    Type.String({
      description: "Editable text the owner may change before acting, e.g. an email or post.",
    }),
  ),
  draftHeader: Type.Optional(
    Type.String({ description: 'Muted lines above the draft, e.g. "To: Dana\nRe: Q3 proposal".' }),
  ),
  metric: Type.Optional(
    strictObject({
      value: Type.String({ description: 'Headline number, e.g. "$4.2M".' }),
      delta: Type.Optional(Type.String({ description: 'Change line, e.g. "+12% vs Q2".' })),
      caption: Type.Optional(Type.String({ description: "Muted caption." })),
      bars: Type.Optional(
        Type.Array(strictObject({ label: Type.String(), value: Type.Number() }), {
          description: "Small bar chart; the last bar is highlighted.",
        }),
      ),
    }),
  ),
  links: Type.Optional(
    Type.Array(strictObject({ label: Type.String(), url: Type.String() }), {
      description: "Link chips, e.g. Open draft. Pass [] to clear.",
    }),
  ),
  actions: Type.Optional(
    Type.Array(
      strictObject({
        label: Type.String({ description: "Button text, e.g. Send." }),
        message: Type.String({
          description: "Text sent back to the notify session when the owner clicks.",
        }),
        style: Type.Optional(Type.String({ description: "primary or secondary." })),
        doneLabel: Type.Optional(Type.String({ description: "Button text after the click." })),
        id: Type.Optional(Type.String({ description: "Stable action id." })),
      }),
      { description: "Up to 4 buttons. Pass [] to clear." },
    ),
  ),
  doneLabel: Type.Optional(
    Type.String({ description: 'One line shown once handled, e.g. "Sent the Q3 proposal".' }),
  ),
  notify: Type.Optional(
    Type.String({
      description:
        "Session key that receives clicks and comments. Default: your agent main session.",
    }),
  ),
  snoozeUntil: SnoozeUntilField,
};
