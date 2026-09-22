import { describe, expect, it, vi } from "vitest";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
  makeTelegramApiTestMock,
} from "./send.test-harness.js";

installTelegramSendTestHooks();
const { botCtorSpy } = getTelegramSendTestMocks();
const { createForumTopicTelegram, editForumTopicTelegram } = await importTelegramSendModule();
const TELEGRAM_TEST_CFG = {};

describe("createForumTopicTelegram", () => {
  it("preserves captured platform authority after awaited preparation", async () => {
    let platformCurrent = true;
    const createForumTopic = vi.fn();
    const getChat = vi.fn();
    const options = {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api: makeTelegramApiTestMock({ createForumTopic, getChat }),
      assertPlatformSendAuthorized: () => {
        if (!platformCurrent) {
          throw new Error("Platform request authority revoked");
        }
      },
    };
    getChat.mockImplementationOnce(async () => {
      platformCurrent = false;
      options.assertPlatformSendAuthorized = () => {};
      return { id: -100123 };
    });
    await expect(
      createForumTopicTelegram("@platformbound", "Bound topic", options),
    ).rejects.toThrow("Platform request authority revoked");
    expect(getChat).toHaveBeenCalledOnce();
    expect(createForumTopic).not.toHaveBeenCalled();
  });

  const cases = [
    {
      name: "uses base chat id when target includes topic suffix",
      target: "telegram:group:-1001234567890:topic:271",
      title: "x",
      response: { message_thread_id: 272, name: "Build Updates" },
      expectedCall: ["-1001234567890", "x", undefined] as const,
      expectedResult: {
        topicId: 272,
        name: "Build Updates",
        chatId: "-1001234567890",
      },
    },
    {
      name: "forwards optional icon fields",
      target: "-1001234567890",
      title: "Roadmap",
      response: { message_thread_id: 300, name: "Roadmap" },
      options: {
        iconColor: 0x6fb9f0,
        iconCustomEmojiId: "  1234567890  ",
      },
      expectedCall: [
        "-1001234567890",
        "Roadmap",
        { icon_color: 0x6fb9f0, icon_custom_emoji_id: "1234567890" },
      ] as const,
      expectedResult: {
        topicId: 300,
        name: "Roadmap",
        chatId: "-1001234567890",
      },
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const createForumTopic = vi.fn().mockResolvedValue(testCase.response);
      const api = makeTelegramApiTestMock({ createForumTopic });

      const result = await createForumTopicTelegram(testCase.target, testCase.title, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        ...("options" in testCase ? testCase.options : {}),
      });

      expect(createForumTopic).toHaveBeenCalledWith(...testCase.expectedCall);
      expect(result).toEqual(testCase.expectedResult);
    });
  }

  it.each([
    ["65 emoji", "🎃".repeat(65)],
    ["128 emoji", "🎃".repeat(128)],
    ["128 mixed emoji and ASCII characters", "🎃".repeat(64) + "a".repeat(64)],
    ["128 CJK characters", "界".repeat(128)],
  ])("accepts %s forum topic names by Unicode code points", async (_label, name) => {
    const createForumTopic = vi.fn().mockResolvedValue({ message_thread_id: 400, name });
    const api = makeTelegramApiTestMock({ createForumTopic });

    await createForumTopicTelegram("-1001234567890", name, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
    });

    expect(createForumTopic).toHaveBeenCalledWith("-1001234567890", name, undefined);
  });

  it("rejects an invalid topic name before creating a Telegram client", async () => {
    botCtorSpy.mockClear();

    await expect(
      createForumTopicTelegram("-1001234567890", "   ", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
      }),
    ).rejects.toThrow("Forum topic name is required");
    expect(botCtorSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["129 ASCII characters", "a".repeat(129)],
    ["129 emoji", "🎃".repeat(129)],
    ["19 multi-code-point emoji graphemes", "👨‍👩‍👧‍👦".repeat(19)],
  ])("rejects %s exceeding 128 Unicode code points on create and edit", async (_label, name) => {
    const createForumTopic = vi.fn();
    const editForumTopic = vi.fn();
    const api = makeTelegramApiTestMock({ createForumTopic, editForumTopic });

    await expect(
      createForumTopicTelegram("-1001234567890", name, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      }),
    ).rejects.toThrow("128 characters or fewer");
    await expect(
      editForumTopicTelegram("-1001234567890", 271, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        name,
      }),
    ).rejects.toThrow("128 characters or fewer");

    expect(createForumTopic).not.toHaveBeenCalled();
    expect(editForumTopic).not.toHaveBeenCalled();
  });
});
