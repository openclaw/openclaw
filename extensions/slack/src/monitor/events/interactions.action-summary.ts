import { parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import {
  asOptionalObjectRecord,
  normalizeUniqueTrimmedStringList,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateSlackText } from "../../truncate.js";
import type { ModalInputSummary } from "./modal-input-summary.js";

export type SlackActionSummary = Omit<ModalInputSummary, "actionId" | "blockId"> & {
  workflowTriggerUrl?: string;
  workflowId?: string;
};

function readOptionStrings(
  options: unknown,
  read: (option: Record<string, unknown>) => unknown,
): string[] {
  if (!Array.isArray(options)) {
    return [];
  }
  return options
    .map((option) => {
      const record = asOptionalObjectRecord(option);
      return record ? read(record) : undefined;
    })
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function collectRichTextFragments(value: unknown, out: string[]): void {
  const typed = asOptionalObjectRecord(value);
  if (!typed) {
    return;
  }
  if (typeof typed.text === "string" && typed.text.trim().length > 0) {
    out.push(typed.text.trim());
  }
  if (Array.isArray(typed.elements)) {
    for (const child of typed.elements) {
      collectRichTextFragments(child, out);
    }
  }
}

function summarizeRichTextPreview(value: unknown): string | undefined {
  const fragments: string[] = [];
  collectRichTextFragments(value, fragments);
  if (fragments.length === 0) {
    return undefined;
  }
  const joined = fragments.join(" ").replace(/\s+/g, " ").trim();
  return truncateSlackText(joined, 120);
}

export function summarizeAction(action: Record<string, unknown>): SlackActionSummary {
  const typed = action;
  const actionType = readStringValue(typed.type);
  const selectedOption = asOptionalObjectRecord(typed.selected_option);
  const selectedOptionText = asOptionalObjectRecord(selectedOption?.text);
  const workflow = asOptionalObjectRecord(typed.workflow);
  const selectedUsers = normalizeUniqueTrimmedStringList([
    ...(typed.selected_user ? [typed.selected_user] : []),
    ...(Array.isArray(typed.selected_users) ? typed.selected_users : []),
  ]);
  const selectedChannels = normalizeUniqueTrimmedStringList([
    ...(typed.selected_channel ? [typed.selected_channel] : []),
    ...(Array.isArray(typed.selected_channels) ? typed.selected_channels : []),
  ]);
  const selectedConversations = normalizeUniqueTrimmedStringList([
    ...(typed.selected_conversation ? [typed.selected_conversation] : []),
    ...(Array.isArray(typed.selected_conversations) ? typed.selected_conversations : []),
  ]);
  const selectedValues = normalizeUniqueTrimmedStringList([
    selectedOption?.value,
    ...readOptionStrings(typed.selected_options, (option) => option.value),
    ...selectedUsers,
    ...selectedChannels,
    ...selectedConversations,
  ]);
  const selectedLabels = normalizeUniqueTrimmedStringList([
    selectedOptionText?.text,
    ...readOptionStrings(
      typed.selected_options,
      (option) => asOptionalObjectRecord(option.text)?.text,
    ),
  ]);
  const inputValue = typeof typed.value === "string" ? typed.value : undefined;
  const inputNumber =
    actionType === "number_input" && inputValue != null
      ? parseStrictFiniteNumber(inputValue)
      : undefined;
  const inputEmail =
    actionType === "email_text_input" && inputValue?.includes("@") ? inputValue : undefined;
  const inputUrl =
    actionType === "url_text_input" && inputValue ? URL.parse(inputValue)?.toString() : undefined;
  const richTextValue = actionType === "rich_text_input" ? typed.rich_text_value : undefined;
  const richTextPreview = summarizeRichTextPreview(richTextValue);
  const inputKind =
    actionType === "number_input"
      ? "number"
      : actionType === "email_text_input"
        ? "email"
        : actionType === "url_text_input"
          ? "url"
          : actionType === "rich_text_input"
            ? "rich_text"
            : inputValue != null
              ? "text"
              : undefined;

  return {
    actionType,
    inputKind,
    value: inputValue,
    selectedValues: selectedValues.length > 0 ? selectedValues : undefined,
    selectedUsers: selectedUsers.length > 0 ? selectedUsers : undefined,
    selectedChannels: selectedChannels.length > 0 ? selectedChannels : undefined,
    selectedConversations: selectedConversations.length > 0 ? selectedConversations : undefined,
    selectedLabels: selectedLabels.length > 0 ? selectedLabels : undefined,
    selectedDate: readStringValue(typed.selected_date),
    selectedTime: readStringValue(typed.selected_time),
    selectedDateTime:
      typeof typed.selected_date_time === "number" ? typed.selected_date_time : undefined,
    inputValue,
    inputNumber,
    inputEmail,
    inputUrl,
    richTextValue,
    richTextPreview,
    workflowTriggerUrl: readStringValue(workflow?.trigger_url),
    workflowId: readStringValue(workflow?.workflow_id),
  };
}
