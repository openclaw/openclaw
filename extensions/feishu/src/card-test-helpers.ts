import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
// Feishu helper module supports card test helpers behavior.
import { expect } from "vitest";

type MockCalls = {
  mock: { calls: unknown[][] };
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readFeishuObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? asRecord(value) : undefined;
}

export function expectFirstSentCardUsesFillWidthOnly(sendCardMock: {
  mock: { calls: unknown[][] };
}) {
  const firstSendArg = sendCardMock.mock.calls.at(0)?.[0] as
    | {
        card?: {
          config?: {
            width_mode?: string;
            wide_screen_mode?: boolean;
            enable_forward?: boolean;
          };
        };
      }
    | undefined;
  const sentCard = firstSendArg?.card;
  expect(sentCard).toBeDefined();
  expect(sentCard?.config?.width_mode).toBe("fill");
  expect(sentCard?.config?.wide_screen_mode).toBeUndefined();
  expect(sentCard?.config?.enable_forward).toBeUndefined();
}

export function expectFeishuCardButtonRow(card: unknown): Record<string, unknown>[] {
  const record = readFeishuObjectRecord(card);
  expect(record?.schema).toBe("2.0");
  const elements = asArray(readFeishuObjectRecord(record?.body)?.elements);
  expect(elements.some((element) => readFeishuObjectRecord(element)?.tag === "action")).toBe(false);
  const row = readFeishuObjectRecord(
    elements.find((element) => readFeishuObjectRecord(element)?.tag === "column_set"),
  );
  expect(row).toMatchObject({
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "default",
  });
  const columns = asArray(row?.columns);
  expect(columns.length).toBeGreaterThan(0);
  return columns.map((column) => {
    const columnRecord = readFeishuObjectRecord(column);
    expect(columnRecord).toMatchObject({ tag: "column", width: "auto", vertical_align: "center" });
    const buttons = asArray(columnRecord?.elements);
    expect(buttons).toHaveLength(1);
    const button = readFeishuObjectRecord(buttons[0]);
    if (!button || button.tag !== "button") {
      throw new Error("Expected a button in each V2 column");
    }
    return button;
  });
}

export function expectSentCardHasP2pAction(sendCardMock: MockCalls) {
  expect(sendCardMock.mock.calls.length).toBeGreaterThan(0);
  const hasP2pAction = sendCardMock.mock.calls.some(([arg]) => {
    const buttons = expectFeishuCardButtonRow(readFeishuObjectRecord(arg)?.card);
    return buttons.some((button) => {
      const value = readFeishuObjectRecord(button.value);
      return readFeishuObjectRecord(value?.c)?.t === "p2p";
    });
  });
  expect(hasP2pAction).toBe(true);
}
