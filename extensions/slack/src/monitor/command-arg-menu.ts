// Slack native command argument menu rendering and bounded value encoding.
import { chunkItems } from "openclaw/plugin-sdk/text-chunking";
import { SLACK_MAX_BLOCKS } from "../blocks-input.js";
import { truncateSlackText } from "../truncate.js";
import {
  SLACK_EXTERNAL_ARG_MENU_PREFIX,
  type SlackExternalArgMenuChoice,
} from "./external-arg-menu-store.js";
import { escapeSlackMrkdwn } from "./mrkdwn.js";

export const SLACK_COMMAND_ARG_ACTION_ID = "openclaw_cmdarg";
export const SLACK_COMMAND_ARG_ACTION_LISTENER = /^openclaw_cmdarg/;
export const SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX = 100;
export const SLACK_COMMAND_ARG_SELECT_OPTION_TEXT_MAX = 75;

const SLACK_COMMAND_ARG_VALUE_PREFIX = "cmdarg";
const SLACK_COMMAND_ARG_BUTTON_ROW_SIZE = 5;
const SLACK_COMMAND_ARG_OVERFLOW_MIN = 3;
const SLACK_COMMAND_ARG_OVERFLOW_MAX = 5;
const SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX = 150;
const SLACK_COMMAND_ARG_BUTTON_TEXT_MAX = 75;
const SLACK_COMMAND_ARG_BUTTON_VALUE_MAX = 2000;
const SLACK_COMMAND_ARG_CONFIRM_TEXT_MAX = 300;
const SLACK_HEADER_TEXT_MAX = 150;
const SLACK_COMMAND_ARG_CHROME_BLOCKS = 3;
const SLACK_COMMAND_ARG_ACTION_BLOCKS_MAX = SLACK_MAX_BLOCKS - SLACK_COMMAND_ARG_CHROME_BLOCKS;

type EncodedMenuChoice = SlackExternalArgMenuChoice;

function buildSlackArgMenuConfirm(params: { command: string; arg: string }) {
  const command = escapeSlackMrkdwn(params.command);
  const arg = escapeSlackMrkdwn(params.arg);
  return {
    title: { type: "plain_text", text: "Confirm selection" },
    text: {
      type: "mrkdwn",
      text: truncateSlackText(
        `Run */${command}* with *${arg}* set to this value?`,
        SLACK_COMMAND_ARG_CONFIRM_TEXT_MAX,
      ),
    },
    confirm: { type: "plain_text", text: "Run command" },
    deny: { type: "plain_text", text: "Cancel" },
  };
}

function encodeSlackCommandArgValue(parts: {
  command: string;
  arg: string;
  value: string;
  userId: string;
}) {
  return [
    SLACK_COMMAND_ARG_VALUE_PREFIX,
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId),
  ].join("|");
}

export function parseSlackCommandArgValue(raw?: string | null): {
  command: string;
  arg: string;
  value: string;
  userId: string;
} | null {
  if (!raw) {
    return null;
  }
  const parts = raw.split("|");
  if (parts.length !== 5 || parts[0] !== SLACK_COMMAND_ARG_VALUE_PREFIX) {
    return null;
  }
  const [, command, arg, value, userId] = parts;
  if (!command || !arg || !value || !userId) {
    return null;
  }
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return null;
    }
  };
  const decodedCommand = decode(command);
  const decodedArg = decode(arg);
  const decodedValue = decode(value);
  const decodedUserId = decode(userId);
  if (!decodedCommand || !decodedArg || !decodedValue || !decodedUserId) {
    return null;
  }
  return {
    command: decodedCommand,
    arg: decodedArg,
    value: decodedValue,
    userId: decodedUserId,
  };
}

function buildSlackArgMenuOptions(choices: EncodedMenuChoice[]) {
  return choices.map((choice) => ({
    text: {
      type: "plain_text",
      text: truncateSlackText(choice.label, SLACK_COMMAND_ARG_SELECT_OPTION_TEXT_MAX),
    },
    value: choice.value,
  }));
}

function buildSlackArgMenuActionsBlock(elements: Array<Record<string, unknown>>, blockId?: string) {
  return {
    type: "actions",
    ...(blockId ? { block_id: blockId } : {}),
    elements,
  };
}

export function buildSlackCommandArgMenuBlocks(params: {
  title: string;
  command: string;
  arg: string;
  choices: Array<{ value: string; label: string }>;
  userId: string;
  supportsExternalSelect: boolean;
  createStoredMenu: (choices: EncodedMenuChoice[]) => string;
}) {
  const encodedChoices = params.choices.map((choice) => ({
    label: choice.label,
    searchValue: choice.value,
    value: encodeSlackCommandArgValue({
      command: params.command,
      arg: params.arg,
      value: choice.value,
      userId: params.userId,
    }),
  }));
  const canUseExternalSelect =
    params.supportsExternalSelect && encodedChoices.length > SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX;
  const canUseOverflow =
    encodedChoices.length >= SLACK_COMMAND_ARG_OVERFLOW_MIN &&
    encodedChoices.length <= SLACK_COMMAND_ARG_OVERFLOW_MAX;
  const directValueLimit =
    canUseOverflow || encodedChoices.length > SLACK_COMMAND_ARG_BUTTON_ROW_SIZE
      ? SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX
      : SLACK_COMMAND_ARG_BUTTON_VALUE_MAX;
  const needsBoundedRefs = encodedChoices.some((choice) => choice.value.length > directValueLimit);
  const storedMenuToken =
    needsBoundedRefs || canUseExternalSelect ? params.createStoredMenu(encodedChoices) : undefined;
  const menuChoices =
    needsBoundedRefs && storedMenuToken
      ? encodedChoices.map((choice, index) => ({ ...choice, value: index.toString(36) }))
      : encodedChoices;
  const storedBlockId = storedMenuToken
    ? `${SLACK_EXTERNAL_ARG_MENU_PREFIX}${storedMenuToken}`
    : undefined;
  const rows = canUseExternalSelect
    ? [
        buildSlackArgMenuActionsBlock(
          [
            {
              type: "external_select",
              action_id: SLACK_COMMAND_ARG_ACTION_ID,
              confirm: buildSlackArgMenuConfirm({ command: params.command, arg: params.arg }),
              min_query_length: 0,
              placeholder: { type: "plain_text", text: `Search ${params.arg}` },
            },
          ],
          storedBlockId,
        ),
      ]
    : canUseOverflow
      ? [
          buildSlackArgMenuActionsBlock(
            [
              {
                type: "overflow",
                action_id: SLACK_COMMAND_ARG_ACTION_ID,
                confirm: buildSlackArgMenuConfirm({ command: params.command, arg: params.arg }),
                options: buildSlackArgMenuOptions(menuChoices),
              },
            ],
            storedBlockId,
          ),
        ]
      : menuChoices.length <= SLACK_COMMAND_ARG_BUTTON_ROW_SIZE
        ? chunkItems(menuChoices, SLACK_COMMAND_ARG_BUTTON_ROW_SIZE).map((choices, rowIndex) =>
            buildSlackArgMenuActionsBlock(
              choices.map((choice, colIndex) => ({
                type: "button",
                action_id: `${SLACK_COMMAND_ARG_ACTION_ID}_${rowIndex}_${colIndex}`,
                text: {
                  type: "plain_text",
                  text: truncateSlackText(choice.label, SLACK_COMMAND_ARG_BUTTON_TEXT_MAX),
                },
                value: choice.value,
                confirm: buildSlackArgMenuConfirm({ command: params.command, arg: params.arg }),
              })),
              storedBlockId,
            ),
          )
        : chunkItems(menuChoices, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX).map((choices, index) =>
            buildSlackArgMenuActionsBlock(
              [
                {
                  type: "static_select",
                  action_id: SLACK_COMMAND_ARG_ACTION_ID,
                  confirm: buildSlackArgMenuConfirm({ command: params.command, arg: params.arg }),
                  placeholder: {
                    type: "plain_text",
                    text:
                      index === 0 ? `Choose ${params.arg}` : `Choose ${params.arg} (${index + 1})`,
                  },
                  options: buildSlackArgMenuOptions(choices),
                },
              ],
              storedBlockId ? `${storedBlockId}:${index.toString(36)}` : undefined,
            ),
          );
  const headerText = truncateSlackText(
    `/${params.command}: choose ${params.arg}`,
    SLACK_HEADER_TEXT_MAX,
  );
  const sectionText = truncateSlackText(params.title, 3000);
  const visibleRows = rows.slice(0, SLACK_COMMAND_ARG_ACTION_BLOCKS_MAX);
  const contextText = truncateSlackText(
    rows.length > visibleRows.length
      ? `Some options do not fit in this menu. Type /${params.command} <value> to select an option not shown.`
      : `Select one option to continue /${params.command} (${params.arg})`,
    3000,
  );
  return [
    { type: "header", text: { type: "plain_text", text: headerText } },
    { type: "section", text: { type: "mrkdwn", text: sectionText } },
    { type: "context", elements: [{ type: "mrkdwn", text: contextText }] },
    ...visibleRows,
  ];
}
