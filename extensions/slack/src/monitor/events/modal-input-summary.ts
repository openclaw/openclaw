import {
  parseStrictFiniteNumber,
  timestampMsToIsoString,
} from "openclaw/plugin-sdk/number-runtime";
import {
  asOptionalObjectRecord,
  normalizeUniqueTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateSlackText } from "../../truncate.js";

export type ModalInputSummary = {
  blockId: string;
  actionId: string;
  actionType?: string;
  inputKind?: "text" | "number" | "email" | "url" | "rich_text";
  value?: string;
  selectedValues?: string[];
  selectedUsers?: string[];
  selectedChannels?: string[];
  selectedConversations?: string[];
  selectedLabels?: string[];
  selectedDate?: string;
  selectedTime?: string;
  selectedDateTime?: number;
  inputValue?: string;
  inputNumber?: number;
  inputEmail?: string;
  inputUrl?: string;
  richTextValue?: unknown;
  richTextPreview?: string;
};

type SelectOption = {
  value?: string;
  text?: { text?: string };
};

export type SlackActionSummary = Omit<ModalInputSummary, "actionId" | "blockId"> & {
  workflowTriggerUrl?: string;
  workflowId?: string;
};

function readOptionStrings(options: unknown, read: (option: SelectOption) => unknown): string[] {
  if (!Array.isArray(options)) {
    return [];
  }
  return options
    .map((option) => (option && typeof option === "object" ? read(option) : undefined))
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
  // SAFETY: Bolt block actions and ViewStateValue own these optional fields; this projection preserves their values.
  const typed = action as {
    type?: string;
    selected_option?: SelectOption;
    selected_options?: SelectOption[];
    selected_user?: string;
    selected_users?: string[];
    selected_channel?: string;
    selected_channels?: string[];
    selected_conversation?: string;
    selected_conversations?: string[];
    selected_date?: string;
    selected_time?: string;
    selected_date_time?: number;
    value?: string;
    rich_text_value?: unknown;
    workflow?: {
      trigger_url?: string;
      workflow_id?: string;
    };
  };
  const actionType = typed.type;
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
    ...(typed.selected_option?.value ? [typed.selected_option.value] : []),
    ...readOptionStrings(typed.selected_options, (option) => option.value),
    ...selectedUsers,
    ...selectedChannels,
    ...selectedConversations,
  ]);
  const selectedLabels = normalizeUniqueTrimmedStringList([
    ...(typed.selected_option?.text?.text ? [typed.selected_option.text.text] : []),
    ...readOptionStrings(typed.selected_options, (option) => option.text?.text),
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
    value: typed.value,
    selectedValues: selectedValues.length > 0 ? selectedValues : undefined,
    selectedUsers: selectedUsers.length > 0 ? selectedUsers : undefined,
    selectedChannels: selectedChannels.length > 0 ? selectedChannels : undefined,
    selectedConversations: selectedConversations.length > 0 ? selectedConversations : undefined,
    selectedLabels: selectedLabels.length > 0 ? selectedLabels : undefined,
    selectedDate: typed.selected_date,
    selectedTime: typed.selected_time,
    selectedDateTime:
      typeof typed.selected_date_time === "number" ? typed.selected_date_time : undefined,
    inputValue,
    inputNumber,
    inputEmail,
    inputUrl,
    richTextValue,
    richTextPreview,
    workflowTriggerUrl: typed.workflow?.trigger_url,
    workflowId: typed.workflow?.workflow_id,
  };
}

export function summarizeSlackViewState(values: unknown): ModalInputSummary[] {
  const blocks = asOptionalObjectRecord(values);
  if (!blocks) {
    return [];
  }
  const entries: ModalInputSummary[] = [];
  for (const [blockId, blockValue] of Object.entries(blocks)) {
    const actions = asOptionalObjectRecord(blockValue);
    if (!actions) {
      continue;
    }
    for (const [actionId, rawAction] of Object.entries(actions)) {
      const action = asOptionalObjectRecord(rawAction);
      if (!action) {
        continue;
      }
      const actionSummary = summarizeAction(action);
      entries.push({
        blockId,
        actionId,
        ...actionSummary,
      });
    }
  }
  return entries;
}

export function formatInteractionSelectionLabel(params: {
  actionId: string;
  summary: SlackActionSummary;
  buttonText?: string;
}): string {
  if (params.summary.actionType === "button" && params.buttonText?.trim()) {
    return params.buttonText.trim();
  }
  const selected = params.summary.selectedLabels?.length
    ? params.summary.selectedLabels
    : params.summary.selectedValues;
  if (selected?.length) {
    return selected.length <= 3
      ? selected.join(", ")
      : `${selected.slice(0, 3).join(", ")} +${selected.length - 3}`;
  }
  if (params.summary.selectedDate) {
    return params.summary.selectedDate;
  }
  if (params.summary.selectedTime) {
    return params.summary.selectedTime;
  }
  if (typeof params.summary.selectedDateTime === "number") {
    const selectedDateTime = timestampMsToIsoString(params.summary.selectedDateTime * 1000);
    if (selectedDateTime) {
      return selectedDateTime;
    }
  }
  if (params.summary.richTextPreview) {
    return params.summary.richTextPreview;
  }
  if (params.summary.value?.trim()) {
    return params.summary.value.trim();
  }
  return params.actionId;
}
