import { expect, it } from "vitest";
import { workboardTestHost } from "../test/host.setup.ts";
import { t } from "./index.ts";
import { loadMessages } from "./locales.ts";

it("uses the host locale for migrated Workboard and session-action translations", async () => {
  Object.assign(workboardTestHost().host, { locale: "zh-CN" });
  await loadMessages("zh-CN");
  expect(t("workboard.widget.boardLabel")).toBe("Workboard 看板");
  expect(t("sessionsView.addToWorkboard")).toBe("添加到 Workboard");
  expect(t("sessionsView.openWorkboardCard")).toBe("打开 Workboard 卡片");
  expect(t("workboard.widget.cardCount", { count: "3" })).toBe("3 张卡片");
});

it("falls back to English for an untranslated locale", () => {
  Object.assign(workboardTestHost().host, { locale: "unsupported-locale" });
  expect(t("workboard.newCard")).toBe("New card");
});
