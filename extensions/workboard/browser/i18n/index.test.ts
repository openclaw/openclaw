import { expect, it } from "vitest";
import { workboardTestHost } from "../test/host.setup.ts";
import { t } from "./index.ts";
import { loadMessages } from "./locales.ts";

it("uses the host locale for migrated Workboard translations", async () => {
  Object.assign(workboardTestHost().host, { locale: "zh-CN" });
  await loadMessages("zh-CN");
  expect(t("workboard.widget.boardLabel")).toBe("Workboard 看板");
  expect(t("workboard.widget.cardCount", { count: "3" })).toBe("3 张卡片");
});

it("falls back to English for an untranslated locale", () => {
  Object.assign(workboardTestHost().host, { locale: "unsupported-locale" });
  expect(t("workboard.newCard")).toBe("New card");
});

it("shows distinct Polish labels for the Ready and Done columns", async () => {
  Object.assign(workboardTestHost().host, { locale: "pl" });
  await loadMessages("pl");
  expect(t("workboard.status.ready")).toBe("Gotowe do podjęcia");
  expect(t("workboard.status.done")).toBe("Gotowe");
  expect(t("workboard.status.ready")).not.toBe(t("workboard.status.done"));
  expect(t("workboard.status.running")).toBe(t("workboard.viewRunning"));
});
